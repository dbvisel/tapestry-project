import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  PutObjectCommandInput,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { config } from '../config.js'
import { compact } from 'lodash-es'
import { fileExtension, isHTTPURL } from 'tapestry-core/src/utils.js'
import { RedisCache } from './redis.js'

const Bucket = config.aws.s3.bucketName

class S3Service {
  // Used only to sign URLs handed to the browser (uploads, asset display). Must be reachable
  // from wherever the browser runs.
  private s3Client: S3Client
  // Used for every direct SDK call (put/copy/delete/list/get) and for signing URLs that the
  // server/worker fetch themselves. Must be reachable from inside the server/worker containers.
  private internalS3Client: S3Client
  private cache = new RedisCache('s3')

  constructor() {
    const { endpointUrl, internalEndpointUrl, accessKeyId, secretAccessKey, region } = config.aws
    const credentials = accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined
    const forcePathStyle = config.aws.s3.forcePathStyle

    this.s3Client = new S3Client({
      endpoint: endpointUrl || undefined,
      region: region || undefined,
      credentials,
      forcePathStyle,
    })

    this.internalS3Client = new S3Client({
      endpoint: internalEndpointUrl || undefined,
      region: region || undefined,
      credentials,
      forcePathStyle,
    })
  }

  private async getPresignedUrl(
    client: S3Client,
    command: PutObjectCommand | GetObjectCommand,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(client, command, { expiresIn })
  }

  async getCreateObjectUrl(key: string, mimeType: string, expiresIn: number): Promise<string> {
    return this.getPresignedUrl(
      this.s3Client,
      new PutObjectCommand({
        Bucket,
        Key: key,
        ContentType: mimeType,
        CacheControl: "no-store, no-cache, must-revalidate, max-age=0", // <-- IMPORTANT
      }),
      expiresIn,
    )
  }

  async getReadObjectUrl(
    key: string,
    expiresIn = config.server.assetReadUrlExpiresIn,
  ): Promise<string> {
    return this.cache.memoize(
      key,
      () =>
        this.getPresignedUrl(
          this.s3Client,
          new GetObjectCommand({
            Bucket,
            Key: key,
          }),
          expiresIn,
        ),
      expiresIn >> 1,
      async (cachedUrl) => {
        try {
          const response = await fetch(cachedUrl, { headers: { Range: 'bytes=0-0' } })
          return response.ok
        } catch (error) {
          console.error('Error while validating cached URL', error)
          return false
        }
      },
      config.server.assetReadUrlValidationExpiresIn,
    )
  }

  // Like getReadObjectUrl, but signed for the internal endpoint. Use this when the server or
  // worker itself is going to fetch the URL (e.g. streaming an uploaded file for processing) —
  // never hand this URL to the browser.
  async getInternalReadObjectUrl(
    key: string,
    expiresIn = config.server.assetReadUrlExpiresIn,
  ): Promise<string> {
    return this.getPresignedUrl(
      this.internalS3Client,
      new GetObjectCommand({
        Bucket,
        Key: key,
      }),
      expiresIn,
    )
  }

  async copyObject(key: string, newObjectKey: string) {
    return this.internalS3Client.send(
      new CopyObjectCommand({
        Bucket,
        CopySource: `/${Bucket}/${key}`,
        Key: newObjectKey,
      }),
    )
  }

  async putObject(key: string, body: PutObjectCommandInput['Body'], contentType?: string) {
    return this.internalS3Client.send(
      new PutObjectCommand({
        Bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    )
  }

  async deleteObject(key: string) {
    try {
      return this.internalS3Client.send(
        new DeleteObjectCommand({
          Bucket,
          Key: key,
        }),
      )
    } catch (e) {
      console.warn(`There was an error deleting ${key} from S3`, e)
      throw e
    }
  }

  async tryDeleteObject(key: string) {
    try {
      await this.deleteObject(key)
    } catch (error) {
      console.warn('Ignoring error while deleting S3 object.', error)
    }
  }

  deleteObjects(keys: string[]) {
    if (keys.length === 0) {
      return
    }

    return this.internalS3Client.send(
      new DeleteObjectsCommand({
        Bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })) },
      }),
    )
  }

  async *listBucket() {
    let token: string | undefined
    do {
      const { NextContinuationToken, Contents } = await this.internalS3Client.send(
        new ListObjectsV2Command({
          Bucket,
          ContinuationToken: token,
        }),
      )
      token = NextContinuationToken
      yield Contents
    } while (token)
  }

  async readObject(key: string) {
    return this.internalS3Client.send(
      new GetObjectCommand({
        Bucket,
        Key: key,
      }),
    )
  }
}

export function generateItemKey(tapestryId: string, item: string) {
  const [, ext] = fileExtension(item)

  return tapestryKey(tapestryId, `${crypto.randomUUID()}${ext ? `.${ext}` : ''}`, true)
}

export function tapestryKey(id: string, objectKey: string, isAsset = false) {
  return compact(['tapestries', id, isAsset ? 'assets' : null, objectKey]).join('/')
}

export function importKey(objectKey: string) {
  return `imports/${objectKey}`
}

export function extractInternallyHostedS3Key(url: string | null | undefined) {
  if (isHTTPURL(url)) {
    const { hostname, pathname } = new URL(url)
    const { hostname: awsHostname } = new URL(config.aws.endpointUrl || 'https://amazonaws.com')
    if (hostname.startsWith(`${config.aws.s3.bucketName}.s3.`) && hostname.endsWith(awsHostname)) {
      return pathname.slice(1)
    }
  }
  return undefined
}

export const s3Service = new S3Service()
