import { S3 } from 'aws-sdk'
import { createWriteStream } from 'fs'

const s3 = new S3({})

export default async function download (s3Path: string, localPath: string): Promise<void> {
  const url = new URL(s3Path)
  await new Promise((resolve, reject) => {
    const stream = s3.getObject({
      Bucket: url.host,
      Key: url.pathname.substring(1)
    })
      .createReadStream()
      .pipe(createWriteStream(localPath))
    stream.on('error', reject)
    stream.on('close', resolve)
  })
}
