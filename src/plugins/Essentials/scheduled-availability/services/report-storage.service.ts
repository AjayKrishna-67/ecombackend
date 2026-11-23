import { Injectable } from '@nestjs/common';
import { InternalServerError, Logger } from '@vendure/core';

const loggerCtx = 'ReportStorage';

/**
 * Publishes a generated report PDF to object storage and returns a URL that is
 * reachable from the public internet.
 *
 * WHY IT HAS TO BE PUBLIC
 * -----------------------
 * Meta downloads the attachment ITSELF when the WhatsApp template is sent. The
 * URL is never fetched by our server, so a localhost path, a signed URL that
 * expires before delivery, or anything behind auth produces a template error
 * with no mention of the file -- which reads like a broken template rather than
 * an unreachable document. That misdiagnosis is the reason this is its own
 * service with its own failure message.
 *
 * DEFAULTS TO the asset bucket (see src/cdn-aware-s3-storage.ts) under a
 * separate `reports/` prefix, so report PDFs never collide with catalogue
 * assets and can be lifecycled independently. Every part of that is an env
 * override, so pointing reports at a DEDICATED bucket is configuration only --
 * see REPORT_S3_* below. Nothing here reaches into AssetServerPlugin's config.
 */
@Injectable()
export class ReportStorageService {
    private readonly bucket = process.env.REPORT_S3_BUCKET ?? 'cdn.kaaikani.co.in';
    private readonly region = process.env.REPORT_S3_REGION ?? process.env.AWS_REGION ?? 'ap-south-1';
    private readonly prefix = process.env.REPORT_S3_PREFIX ?? 'reports';
    /**
     * Public base for the bucket.
     *
     * The default bucket is named for the CDN hostname that fronts it, so
     * `https://<bucket>` happens to be a working URL. A NEW bucket almost never
     * is -- `https://kaaikani-reports` resolves to nothing. So when a different
     * bucket is configured without an explicit public base, fall back to the
     * virtual-hosted S3 endpoint, which always works for a public object. Set
     * REPORT_PUBLIC_BASE_URL when a CDN or custom domain fronts the bucket.
     */
    private readonly publicBase =
        process.env.REPORT_PUBLIC_BASE_URL ??
        (process.env.REPORT_S3_BUCKET
            ? `https://${process.env.REPORT_S3_BUCKET}.s3.${
                  process.env.REPORT_S3_REGION ?? process.env.AWS_REGION ?? 'ap-south-1'
              }.amazonaws.com`
            : 'https://cdn.kaaikani.co.in');

    /**
     * Uploads and returns the public URL.
     *
     * The key carries a date folder so a month of reports is easy to browse and
     * to expire with a lifecycle rule.
     *
     * `objectName` MUST be unique per run, not per day. WhatsApp media is cached
     * by Meta against the URL: two sends of the same URL deliver whatever Meta
     * downloaded the FIRST time, so a re-run that overwrote the object would
     * still show recipients the original sheet. That is not hypothetical -- runs
     * 13440/13471/15611 on 2026-08-07 all published this same key, and the 15:45
     * message displayed the 09:50 content. HTTP cache headers do not fix it;
     * only a different URL does.
     */
    async publishPdf(objectName: string, pdf: Buffer, dateFolder: string): Promise<string> {
        const key = `${this.prefix}/${dateFolder}/${objectName}`;

        let S3Client: any;
        let PutObjectCommand: any;
        try {
            // Lazily required: @aws-sdk is already present for the asset server,
            // but a deployment without it should fail HERE with a clear message
            // rather than at server boot.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
        } catch {
            throw new InternalServerError(
                '@aws-sdk/client-s3 is not installed, so the report PDF cannot be published. ' +
                    'Install it, or set the schedule aside until object storage is available.',
            );
        }

        // Reports may live in their own bucket under their own IAM user -- a key
        // that can ONLY write `reports/` cannot be used to overwrite catalogue
        // assets, which is the point of separating them. Falls back to the asset
        // server's credentials so the default single-bucket setup needs no extra
        // configuration at all.
        const accessKeyId = process.env.REPORT_AWS_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID;
        const secretAccessKey =
            process.env.REPORT_AWS_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY;
        if (!accessKeyId || !secretAccessKey) {
            throw new InternalServerError(
                'Neither REPORT_AWS_ACCESS_KEY_ID / REPORT_AWS_SECRET_ACCESS_KEY nor ' +
                    'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are set, so the report PDF cannot be published.',
            );
        }

        const client = new S3Client({
            region: this.region,
            credentials: { accessKeyId, secretAccessKey },
        });

        await client.send(
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: pdf,
                ContentType: 'application/pdf',
                // NO ACL. This bucket has Object Ownership set to "bucket owner
                // enforced" (the S3 default since 2023), which REJECTS any ACL
                // outright -- `ACL: 'public-read'` fails with "The bucket does
                // not allow ACLs". Public read comes from the bucket policy
                // instead, the same one that already serves catalogue assets
                // from this bucket. If a report ever 403s for Meta, fix the
                // bucket policy; do not reintroduce an ACL here.
                // A purchase list is only correct for the day it was generated;
                // never let a proxy hand back yesterday's sheet.
                CacheControl: 'no-cache',
            }),
        );

        const url = `${this.publicBase.replace(/\/$/, '')}/${key}`;
        Logger.info(`Published ${key} (${pdf.length} bytes)`, loggerCtx);
        return url;
    }
}
