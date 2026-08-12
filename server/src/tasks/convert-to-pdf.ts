import { PDFOptions } from 'puppeteer'
import { JobTypeMap } from '.'
import { prisma } from '../db'
import { initWebpage, inNewBrowserPage, scheduleTapestryThumbnailGeneration } from './utils'
import { s3Service, tapestryKey } from '../services/s3-service'
import { DBSubscriber } from '../socket'
import { pick } from 'lodash-es'
import { Item } from '@prisma/client'

const CONVERT_ITEM_PROPS = [
  'positionX',
  'positionY',
  'width',
  'height',
  'tapestryId',
  'groupId',
  'dropShadow',
] satisfies (keyof Item)[]

async function convertWebpageToPdf(url: string, options?: PDFOptions) {
  let generator: ReturnType<typeof inNewBrowserPage<Uint8Array>> | undefined
  try {
    console.log(`Converting ${url} to pdf...`)
    generator = inNewBrowserPage(async function* (page, context): AsyncGenerator<Uint8Array> {
      await initWebpage(page, context, { url })
      console.log('>  Converting to pdf...')
      yield page.pdf(options)
    })

    const result = await generator.next()
    if (result.done) throw new Error('Expected one value but got none!')

    return result.value
  } finally {
    await generator?.return()
  }
}

export async function convertToPdf({ itemId }: JobTypeMap['convert-to-pdf']) {
  try {
    const item = await prisma.item.findUniqueOrThrow({
      where: { id: itemId },
    })

    if (item.type !== 'webpage' || !item.source) {
      throw new Error(`PDF convertion not supported for item type ${item.type}`)
    }

    const value = await convertWebpageToPdf(item.source, {
      width: item.width,
      height: item.height,
    })

    await prisma.$transaction(async (tx) => {
      await tx.item.delete({ where: { id: item.id } })

      const s3Key = tapestryKey(item.tapestryId, `${crypto.randomUUID()}.pdf`, true)
      await tx.item.create({
        data: {
          ...pick(item, CONVERT_ITEM_PROPS),
          type: 'pdf',
          source: s3Key,
          scheduledThumbnailProcessing: 'derive',
        },
      })
      await s3Service.putObject(s3Key, value, 'application/pdf')
    })

    await scheduleTapestryThumbnailGeneration(item.tapestryId)

    await DBSubscriber.fireNotification({
      name: 'tapestry-updated',
      tapestryId: item.tapestryId,
      deletedIds: { items: [item.id] },
    })
  } catch (error) {
    console.error(`Error while converting item ${itemId} to pdf`, error)
  }
}
