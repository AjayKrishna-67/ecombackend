# Vendure RDS Password Rotation

Automated Lambda that rotates the RDS MySQL password every 30 days and notifies via Slack + Email.

## What it does

1. Generates a new strong random password (32 chars)
2. Updates RDS master password (applies immediately)
3. Updates AWS Secrets Manager (`vendure/prod/database` → `DB_PASSWORD`)
4. Sends Slack notification (`#vendure-critical`)
5. Sends email via SES

**The password is NEVER included in notifications** — you retrieve it from AWS Secrets Manager if needed.

## Architecture

```
EventBridge (cron: monthly)
       ↓
  Lambda Function
       ├→ Generate password
       ├→ RDS ModifyDBInstance
       ├→ Secrets Manager PutSecretValue
       ├→ Slack Webhook
       └→ SES SendEmail
       
Then automatically:
  External Secrets Operator (15 min sync)
       ↓
  Kubernetes Secret updated
       ↓
  Reloader restarts Vendure pods
       ↓
  Pods reconnect with new password
```

## Deploy

```bash
# Edit deploy.sh — set SES_FROM_EMAIL, SES_TO_EMAIL, SLACK_WEBHOOK_URL
nano deploy.sh

# Run it
chmod +x deploy.sh
./deploy.sh
```

On first run, it will send a verification email to `SES_FROM_EMAIL`. Click the link, then re-run.

## Test manually (⚠️ rotates password immediately)

```bash
aws lambda invoke \
  --function-name vendure-rds-password-rotation \
  --region ap-south-1 \
  /tmp/rotation-test.json

cat /tmp/rotation-test.json
```

**Downtime expectation:** 1-2 min of DB errors on existing Vendure pods until:
1. External Secrets Operator syncs (15 min max)
2. Reloader detects secret change and restarts pods
3. New pods connect with new password

**Run it during low-traffic window** (late night IST).

## View logs

```bash
aws logs tail /aws/lambda/vendure-rds-password-rotation \
  --follow --region ap-south-1
```

## Change rotation interval

Edit `deploy.sh`:

```bash
# Monthly on 1st @ 02:30 UTC
--schedule-expression "cron(30 2 1 * ? *)"

# Every 30 days exactly
--schedule-expression "rate(30 days)"

# Every 90 days on the 15th @ midnight UTC
--schedule-expression "cron(0 0 15 */3 ? *)"
```

Then re-run `./deploy.sh`.

## Disable rotation (pause)

```bash
aws events disable-rule \
  --name vendure-rds-rotation-30day \
  --region ap-south-1
```

Re-enable with `enable-rule`.

## Delete everything

```bash
aws events remove-targets --rule vendure-rds-rotation-30day --ids 1 --region ap-south-1
aws events delete-rule --name vendure-rds-rotation-30day --region ap-south-1
aws lambda delete-function --function-name vendure-rds-password-rotation --region ap-south-1
aws iam delete-role-policy --role-name vendure-rds-rotation-lambda-role --policy-name rotation-permissions
aws iam delete-role --role-name vendure-rds-rotation-lambda-role
```

## Retrieve the current password

After rotation, if you need the new password (e.g., for local testing or manual DB access):

```bash
aws secretsmanager get-secret-value \
  --secret-id vendure/prod/database \
  --region ap-south-1 \
  --query SecretString \
  --output text | jq -r .DB_PASSWORD
```

This action is logged in CloudTrail — so it's auditable. Don't share the output.

## Notification format

**Slack:**
```
✅ RDS Password Rotation — SUCCESS
┌─────────────────┬──────────────────────┐
│ RDS Instance    │ vendure-prod-db      │
│ Secret ID       │ vendure/prod/database│
│ Rotated At      │ 2026-05-01 02:30 UTC │
│ Next Rotation   │ 2026-05-31           │
│ Password Length │ 32                   │
│ Secret Version  │ abc-123-...          │
└─────────────────┴──────────────────────┘
```

**Email:** Same info in an HTML table.

## Security notes

- Password length: 32 chars, alphanumeric + 16 special chars
- Password is never logged (CloudWatch logs only contain rotation metadata)
- Password is never in Slack/email (notifications are metadata only)
- Lambda IAM role has minimum permissions (only target RDS + target secret)
- SES sends only to verified internal address
- All Secrets Manager retrievals are logged in CloudTrail
