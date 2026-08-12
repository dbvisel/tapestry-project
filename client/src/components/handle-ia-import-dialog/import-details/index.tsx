import { getIAItemThumbnailURL } from 'tapestry-core/src/internet-archive'
import { IAImport } from '../../../pages/tapestry/view-model'
import styles from './styles.module.css'
import { Text } from 'tapestry-core-client/src/components/lib/text/index'
import { intlFormat } from 'date-fns'
import { Breakpoint, useResponsive } from '../../../providers/responsive-provider'

const parser = new DOMParser()

interface ImportDetailsProps {
  import: IAImport
}

export function ImportDetails({ import: iaImport }: ImportDetailsProps) {
  const mdOrLess = useResponsive() <= Breakpoint.MD
  const textVariant = mdOrLess ? 'bodyXs' : undefined

  if (iaImport.type === 'CommonsCategory') {
    const categoryUrl = `https://commons.wikimedia.org/wiki/${encodeURIComponent(
      iaImport.category.replace(/ /g, '_'),
    )}`

    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <div className={styles.metadataContainer}>
            <Text variant={mdOrLess ? 'bodySm' : 'h6'} lineClamp={2} style={{ fontWeight: 'bold' }}>
              {iaImport.category.replace(/^Category:/, '')}
            </Text>
            <Text variant={textVariant}>{iaImport.total} files</Text>
          </div>
        </div>
        <Text variant={textVariant} component="div">
          <a href={categoryUrl} target="_blank" rel="noopener noreferrer">
            View category on Wikimedia Commons
          </a>
        </Text>
      </div>
    )
  }

  if (iaImport.type === 'OpenverseCollection') {
    const tagUrl = `https://openverse.org/image/collection?tag=${encodeURIComponent(iaImport.tag)}`

    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <div className={styles.metadataContainer}>
            <Text variant={mdOrLess ? 'bodySm' : 'h6'} lineClamp={2} style={{ fontWeight: 'bold' }}>
              {iaImport.tag}
            </Text>
            <Text variant={textVariant}>{iaImport.total} images</Text>
          </div>
        </div>
        <Text variant={textVariant} component="div">
          <a href={tagUrl} target="_blank" rel="noopener noreferrer">
            View collection on Openverse
          </a>
        </Text>
      </div>
    )
  }

  if (iaImport.type === 'IASearch') {
    const searchUrl = `https://archive.org/search?query=${encodeURIComponent(iaImport.query)}`

    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <div className={styles.metadataContainer}>
            <Text variant={mdOrLess ? 'bodySm' : 'h6'} lineClamp={2} style={{ fontWeight: 'bold' }}>
              {iaImport.query}
            </Text>
            <Text variant={textVariant}>{iaImport.total} items</Text>
          </div>
        </div>
        <Text variant={textVariant} component="div">
          <a href={searchUrl} target="_blank" rel="noopener noreferrer">
            View search on Internet Archive
          </a>
        </Text>
      </div>
    )
  }

  const { id, metadata } = iaImport
  const description = parser.parseFromString(
    metadata.summary ?? metadata.description ?? '',
    'text/html',
  ).documentElement.textContent

  const isCollection = metadata.mediatype === 'collection'

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <img className={styles.thumbnail} loading="lazy" src={getIAItemThumbnailURL(id)} />
        <div className={styles.metadataContainer}>
          <div>
            <Text variant={mdOrLess ? 'bodySm' : 'h6'} lineClamp={2} style={{ fontWeight: 'bold' }}>
              {metadata.title}
            </Text>
            <Text variant={textVariant} lineClamp={2}>
              {isCollection ? metadata.uploader : metadata.creator}
            </Text>
          </div>
          <div style={{ display: 'flex', gap: '12px' }}>
            <Text variant={textVariant ?? 'bodySm'}>Publication date</Text>
            <Text variant={textVariant ?? 'bodySm'}>
              {intlFormat(metadata.publicdate, { day: 'numeric', month: 'short', year: 'numeric' })}
            </Text>
          </div>
        </div>
      </div>
      <Text variant={textVariant} component="div">
        {description}
      </Text>
    </div>
  )
}
