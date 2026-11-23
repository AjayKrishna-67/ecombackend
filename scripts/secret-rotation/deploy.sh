#!/bin/bash
# Deploy the RDS password rotation Lambda
# Usage: ./deploy.sh
#
# Prerequisites:
#   - AWS CLI configured with admin access
#   - Lambda function code in lambda_function.py
#   - Your Slack webhook URL
#   - SES verified email address (ses:SendEmail from that address)

set -euo pipefail

# ============================================================================
# CONFIG — EDIT THESE VALUES
# ============================================================================
AWS_REGION="ap-south-1"
LAMBDA_NAME="vendure-rds-password-rotation"
ROLE_NAME="vendure-rds-rotation-lambda-role"
SCHEDULE_NAME="vendure-rds-rotation-30day"

SECRET_ID="vendure/prod/database"
RDS_INSTANCE_ID="vendure-prod-db"
ROTATION_DAYS=30

# EDIT THESE 3 VALUES BEFORE RUNNING:
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/XXX/YYY/ZZZ"
SES_FROM_EMAIL="devops@kaaikani.co.in"   # Must be SES-verified
SES_TO_EMAIL="devops@kaaikani.co.in"

# ============================================================================
# AUTO-DETECTED
# ============================================================================
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_ID" --region "$AWS_REGION" --query ARN --output text)
RDS_ARN="arn:aws:rds:${AWS_REGION}:${AWS_ACCOUNT_ID}:db:${RDS_INSTANCE_ID}"

echo "Account:    $AWS_ACCOUNT_ID"
echo "Region:     $AWS_REGION"
echo "Secret:     $SECRET_ARN"
echo "RDS:        $RDS_ARN"
echo ""

# ============================================================================
# STEP 1: Verify SES email is verified
# ============================================================================
echo "[1/7] Verifying SES email..."
VERIFIED=$(aws ses get-identity-verification-attributes \
  --identities "$SES_FROM_EMAIL" \
  --region "$AWS_REGION" \
  --query "VerificationAttributes.\"$SES_FROM_EMAIL\".VerificationStatus" \
  --output text 2>/dev/null || echo "NotFound")

if [ "$VERIFIED" != "Success" ]; then
  echo "⚠️  SES email $SES_FROM_EMAIL is not verified."
  echo "Verifying now — check your inbox and click the confirmation link, then re-run this script."
  aws ses verify-email-identity --email-address "$SES_FROM_EMAIL" --region "$AWS_REGION"
  exit 1
fi
echo "✓ SES email verified"

# ============================================================================
# STEP 2: Create IAM role for Lambda
# ============================================================================
echo "[2/7] Creating IAM role..."

TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "lambda.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}'

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document "$TRUST_POLICY" \
    --description "Lambda role for Vendure RDS password rotation"
  sleep 5  # Wait for IAM propagation
fi
echo "✓ IAM role ready"

# ============================================================================
# STEP 3: Attach permissions
# ============================================================================
echo "[3/7] Attaching permissions..."

PERMISSION_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": "${SECRET_ARN}"
    },
    {
      "Effect": "Allow",
      "Action": "rds:ModifyDBInstance",
      "Resource": "${RDS_ARN}"
    },
    {
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": "arn:aws:ses:${AWS_REGION}:${AWS_ACCOUNT_ID}:identity/${SES_FROM_EMAIL}"
    }
  ]
}
EOF
)

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "rotation-permissions" \
  --policy-document "$PERMISSION_POLICY"
echo "✓ Permissions attached"

# ============================================================================
# STEP 4: Package and upload Lambda
# ============================================================================
echo "[4/7] Packaging Lambda..."
rm -f lambda_package.zip
zip -j lambda_package.zip lambda_function.py >/dev/null
echo "✓ Package created"

ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${ROLE_NAME}"

if aws lambda get-function --function-name "$LAMBDA_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "[5/7] Updating existing Lambda..."
  aws lambda update-function-code \
    --function-name "$LAMBDA_NAME" \
    --zip-file fileb://lambda_package.zip \
    --region "$AWS_REGION" >/dev/null

  # Wait for the code update to finish before updating config
  aws lambda wait function-updated \
    --function-name "$LAMBDA_NAME" \
    --region "$AWS_REGION"

  aws lambda update-function-configuration \
    --function-name "$LAMBDA_NAME" \
    --region "$AWS_REGION" \
    --environment "Variables={SECRET_ID=$SECRET_ID,RDS_INSTANCE_ID=$RDS_INSTANCE_ID,SLACK_WEBHOOK_URL=$SLACK_WEBHOOK_URL,SES_FROM_EMAIL=$SES_FROM_EMAIL,SES_TO_EMAIL=$SES_TO_EMAIL,ROTATION_DAYS=$ROTATION_DAYS}" >/dev/null
else
  echo "[5/7] Creating Lambda..."
  aws lambda create-function \
    --function-name "$LAMBDA_NAME" \
    --runtime python3.12 \
    --role "$ROLE_ARN" \
    --handler lambda_function.lambda_handler \
    --zip-file fileb://lambda_package.zip \
    --timeout 60 \
    --memory-size 256 \
    --region "$AWS_REGION" \
    --environment "Variables={SECRET_ID=$SECRET_ID,RDS_INSTANCE_ID=$RDS_INSTANCE_ID,SLACK_WEBHOOK_URL=$SLACK_WEBHOOK_URL,SES_FROM_EMAIL=$SES_FROM_EMAIL,SES_TO_EMAIL=$SES_TO_EMAIL,ROTATION_DAYS=$ROTATION_DAYS}" >/dev/null
fi
echo "✓ Lambda deployed"

# ============================================================================
# STEP 6: Create EventBridge schedule (every 30 days)
# ============================================================================
echo "[6/7] Creating EventBridge schedule..."

LAMBDA_ARN="arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${LAMBDA_NAME}"

# Using cron — runs at 02:30 UTC (08:00 IST) on the 1st of every month
# Change this to "rate(30 days)" if you want exactly 30-day intervals
aws events put-rule \
  --name "$SCHEDULE_NAME" \
  --schedule-expression "cron(30 2 1 * ? *)" \
  --description "Rotate Vendure RDS password monthly" \
  --state ENABLED \
  --region "$AWS_REGION" >/dev/null

aws events put-targets \
  --rule "$SCHEDULE_NAME" \
  --targets "Id=1,Arn=$LAMBDA_ARN" \
  --region "$AWS_REGION" >/dev/null

aws lambda add-permission \
  --function-name "$LAMBDA_NAME" \
  --statement-id "AllowEventBridgeInvoke" \
  --action "lambda:InvokeFunction" \
  --principal events.amazonaws.com \
  --source-arn "arn:aws:events:${AWS_REGION}:${AWS_ACCOUNT_ID}:rule/${SCHEDULE_NAME}" \
  --region "$AWS_REGION" 2>/dev/null || true  # OK if already exists

echo "✓ Scheduled: 02:30 UTC (08:00 IST) on the 1st of every month"

# ============================================================================
# STEP 7: Cleanup
# ============================================================================
rm -f lambda_package.zip
echo ""
echo "============================================================================"
echo "✅ Deployment complete!"
echo "============================================================================"
echo ""
echo "Lambda:      $LAMBDA_ARN"
echo "Schedule:    Monthly on 1st @ 02:30 UTC (08:00 IST)"
echo "Notifies:    Slack + Email ($SES_TO_EMAIL)"
echo ""
echo "Test it manually with:"
echo "  aws lambda invoke --function-name $LAMBDA_NAME --region $AWS_REGION /tmp/out.json"
echo "  cat /tmp/out.json"
echo ""
echo "View logs:"
echo "  aws logs tail /aws/lambda/$LAMBDA_NAME --follow --region $AWS_REGION"
echo ""
echo "⚠️  WARNING: Running a test will rotate the password immediately!"
echo "    Do it in a low-traffic window. Vendure pods will have ~1-2 min DB errors"
echo "    until External Secrets Operator syncs (15 min max) and Reloader restarts pods."
