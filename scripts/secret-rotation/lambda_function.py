"""
Vendure RDS Password Rotation Lambda

Runs every 30 days via EventBridge (CloudWatch Events) schedule.

What it does:
1. Generates a new random password (32 chars, alphanumeric + symbols)
2. Updates RDS master password
3. Updates AWS Secrets Manager (vendure/prod/database -> DB_PASSWORD)
4. Sends Slack notification (rotation status, NOT the password)
5. Sends email notification via SES (rotation status, NOT the password)

The External Secrets Operator in the cluster picks up the new password within 15
minutes and Reloader restarts Vendure pods automatically.

SECURITY: Password is NEVER logged, emailed, or sent to Slack. If you need it,
retrieve it from AWS Secrets Manager directly (audited access).
"""

import json
import os
import secrets
import string
from datetime import datetime, timedelta, timezone

import boto3
import urllib3

# Config from environment variables
SECRET_ID = os.environ["SECRET_ID"]                 # vendure/prod/database
RDS_INSTANCE_ID = os.environ["RDS_INSTANCE_ID"]     # vendure-prod-db
SLACK_WEBHOOK_URL = os.environ["SLACK_WEBHOOK_URL"]
SES_FROM_EMAIL = os.environ["SES_FROM_EMAIL"]       # e.g. devops@kaaikani.co.in
SES_TO_EMAIL = os.environ["SES_TO_EMAIL"]           # e.g. devops@kaaikani.co.in
AWS_REGION = os.environ.get("AWS_REGION", "ap-south-1")
ROTATION_DAYS = int(os.environ.get("ROTATION_DAYS", "30"))

secretsmanager = boto3.client("secretsmanager", region_name=AWS_REGION)
rds = boto3.client("rds", region_name=AWS_REGION)
ses = boto3.client("ses", region_name=AWS_REGION)
http = urllib3.PoolManager()


def generate_password(length: int = 32) -> str:
    """Generate a strong random password. RDS MySQL allows these special chars."""
    alphabet = string.ascii_letters + string.digits + "!#$%^&*()-_=+[]{}"
    # Ensure at least one of each class
    while True:
        password = "".join(secrets.choice(alphabet) for _ in range(length))
        if (
            any(c.islower() for c in password)
            and any(c.isupper() for c in password)
            and any(c.isdigit() for c in password)
            and any(c in "!#$%^&*()-_=+[]{}" for c in password)
        ):
            return password


def rotate_rds_password(new_password: str) -> None:
    """Update the RDS master password. Applies immediately."""
    rds.modify_db_instance(
        DBInstanceIdentifier=RDS_INSTANCE_ID,
        MasterUserPassword=new_password,
        ApplyImmediately=True,
    )


def update_secret(new_password: str) -> str:
    """Update the password in Secrets Manager, keeping other fields intact."""
    current = secretsmanager.get_secret_value(SecretId=SECRET_ID)
    data = json.loads(current["SecretString"])
    data["DB_PASSWORD"] = new_password
    response = secretsmanager.put_secret_value(
        SecretId=SECRET_ID, SecretString=json.dumps(data)
    )
    return response["VersionId"]


def send_slack(status: str, details: dict) -> None:
    """Send Slack notification. NEVER includes the password. Scannable format."""
    if status == "success":
        color = "good"
        title = ":large_green_circle: [ROTATED] RDS Password"
    else:
        color = "danger"
        title = ":red_circle: [FAILED] RDS Password Rotation"

    # Scannable key-value text — matches AlertManager format
    text_lines = [
        f"*What changed:*  Password rotated on `{details.get('RDS Instance', 'RDS')}`",
        f"*Resource:*  `{details.get('RDS Instance', 'unknown')}`",
        f"*Secret:*  `{details.get('Secret ID', 'unknown')}`",
        f"*Rotated at:*  {details.get('Rotated At', 'unknown')}",
        f"*Next rotation:*  {details.get('Next Rotation', 'unknown')}",
    ]
    if status != "success" and "Error" in details:
        text_lines.append(f"*Error:*  {details['Error']}")

    payload = {
        "attachments": [
            {
                "color": color,
                "title": title,
                "text": "\n".join(text_lines),
                "footer": "To get the password: AWS Console → Secrets Manager",
                "ts": int(datetime.now(timezone.utc).timestamp()),
            }
        ]
    }
    http.request(
        "POST",
        SLACK_WEBHOOK_URL,
        body=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )


def send_email(status: str, details: dict) -> None:
    """Send email via SES. NEVER includes the password."""
    status_upper = status.upper()
    subject = f"[Vendure Prod] RDS Password Rotation — {status_upper}"

    # HTML table
    rows = "".join(
        f"<tr><td style='padding:8px;border:1px solid #ddd;font-weight:bold;background:#f4f4f4;'>{k}</td>"
        f"<td style='padding:8px;border:1px solid #ddd;'>{v}</td></tr>"
        for k, v in details.items()
    )
    body_html = f"""
    <html><body style="font-family:Arial,sans-serif;color:#333;">
      <h2>RDS Password Rotation — {status_upper}</h2>
      <table style="border-collapse:collapse;width:100%;max-width:600px;">
        {rows}
      </table>
      <p style="margin-top:20px;color:#666;">
        <strong>To retrieve the new password:</strong><br>
        Go to AWS Console → Secrets Manager → <code>{SECRET_ID}</code> → Retrieve secret value.<br>
        This action is logged in CloudTrail for audit.
      </p>
      <p style="color:#999;font-size:12px;">
        Passwords are never included in email or Slack for security.
      </p>
    </body></html>
    """

    # Plain text fallback
    text_rows = "\n".join(f"{k}: {v}" for k, v in details.items())
    body_text = (
        f"RDS Password Rotation — {status_upper}\n\n"
        f"{text_rows}\n\n"
        f"To retrieve the new password, go to AWS Secrets Manager: {SECRET_ID}\n"
        f"Passwords are never included in email for security."
    )

    ses.send_email(
        Source=SES_FROM_EMAIL,
        Destination={"ToAddresses": [SES_TO_EMAIL]},
        Message={
            "Subject": {"Data": subject},
            "Body": {
                "Html": {"Data": body_html},
                "Text": {"Data": body_text},
            },
        },
    )


def lambda_handler(event, context):
    """Main rotation entry point."""
    started_at = datetime.now(timezone.utc)
    next_rotation = started_at + timedelta(days=ROTATION_DAYS)

    details = {
        "RDS Instance": RDS_INSTANCE_ID,
        "Secret ID": SECRET_ID,
        "Region": AWS_REGION,
        "Rotated At": started_at.strftime("%Y-%m-%d %H:%M:%S UTC"),
        "Next Rotation": next_rotation.strftime("%Y-%m-%d"),
        "Rotation Interval": f"{ROTATION_DAYS} days",
    }

    try:
        new_password = generate_password()

        # 1. Update RDS first (applies immediately, existing connections drop)
        rotate_rds_password(new_password)

        # 2. Update Secrets Manager
        version_id = update_secret(new_password)
        details["Secret Version"] = version_id

        # 3. Extra metadata for notifications
        details["Password Length"] = len(new_password)
        details["Downstream Effect"] = (
            "External Secrets Operator will sync within 15 min. "
            "Reloader will restart Vendure pods automatically."
        )

        send_slack("success", details)
        send_email("success", details)

        return {
            "statusCode": 200,
            "body": json.dumps(
                {"status": "success", "rotated_at": details["Rotated At"]}
            ),
        }
    except Exception as error:
        details["Error"] = str(error)[:500]  # Truncate long errors
        try:
            send_slack("failed", details)
            send_email("failed", details)
        except Exception:
            pass  # Don't fail if notification fails
        raise
