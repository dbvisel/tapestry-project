#!/bin/sh
# Creates the S3 bucket (if missing) and applies its CORS rules.
# Runs once in the s3-init container from docker-compose.local.yml / docker-compose-fnf.yml.
# CORS_CONFIG_FILE selects which file under this same directory to apply (defaults to
# the local-dev one), so one script serves both local dev and production init.
set -e

: "${AWS_S3_BUCKET_NAME:?AWS_S3_BUCKET_NAME must be set}"
S3="aws --endpoint-url ${S3_ENDPOINT:-http://seaweedfs:8333}"

echo "Waiting for SeaweedFS S3 gateway..."
until $S3 s3api list-buckets > /dev/null 2>&1; do
  sleep 1
done

if ! $S3 s3api head-bucket --bucket "$AWS_S3_BUCKET_NAME" > /dev/null 2>&1; then
  $S3 s3api create-bucket --bucket "$AWS_S3_BUCKET_NAME"
fi

$S3 s3api put-bucket-cors --bucket "$AWS_S3_BUCKET_NAME" --cors-configuration "file:///scripts/${CORS_CONFIG_FILE:-cors-config.json}"
echo "Bucket '$AWS_S3_BUCKET_NAME' is ready."
