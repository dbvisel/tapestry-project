import DOMPurify from 'dompurify'
import { noop } from 'lodash-es'
import { memo, useMemo } from 'react'
import { IconButton } from 'tapestry-core-client/src/components/lib/buttons/index'
import { useAsync } from 'tapestry-core-client/src/components/lib/hooks/use-async'
import { Icon } from 'tapestry-core-client/src/components/lib/icon/index'
import { LoadingSpinner } from 'tapestry-core-client/src/components/lib/loading-spinner/index'
import { Text } from 'tapestry-core-client/src/components/lib/text/index'
import {
  fetchWikipediaArticleHTML,
  fetchWikipediaCategories,
  fetchWikipediaDisplayTitle,
} from 'tapestry-core/src/wikipedia'
import { WEB_SOURCE_PARSERS } from 'tapestry-core/src/web-sources'
import { WebpageItemDto } from 'tapestry-shared/src/data-transfer/resources/dtos/item'
import { TapestryItemProps } from '..'
import { useTapestryData } from '../../../../pages/tapestry/tapestry-providers'
import { buildToolbarMenu } from '../../item-toolbar'
import { useItemToolbar } from '../../item-toolbar/use-item-toolbar'
import { TapestryItem } from '../tapestry-item'
import styles from './styles.module.css'

/**
 * The REST API returns Parsoid HTML meant to live at "/wiki/<Title>": internal links are relative
 * ("./Other_Article") and images/other interwiki links are protocol-relative ("//upload.wikimedia.org/...").
 * Both need to become absolute for the sanitized article to render and link out correctly when detached from
 * that base, and internal links should open the real Wikipedia page in a new tab rather than navigate the
 * canvas away.
 */
function rewriteArticleDOM(container: HTMLElement, lang: string) {
  container.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href')
    if (!href || href.startsWith('#')) return

    const absolute = href.startsWith('./')
      ? `https://${lang}.wikipedia.org/wiki/${href.slice(2)}`
      : href.startsWith('//')
        ? `https:${href}`
        : null

    if (absolute) anchor.setAttribute('href', absolute)
    anchor.setAttribute('target', '_blank')
    anchor.setAttribute('rel', 'noopener noreferrer')
  })

  container.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src')
    if (src?.startsWith('//')) img.setAttribute('src', `https:${src}`)

    const srcset = img.getAttribute('srcset')
    if (srcset) img.setAttribute('srcset', srcset.replace(/(^|,\s*)\/\//g, '$1https://'))
  })
}

function useSanitizedArticle(html: string | undefined, lang: string) {
  return useMemo(() => {
    if (!html) return undefined

    const container = document.createElement('div')
    container.innerHTML = DOMPurify.sanitize(html)
    rewriteArticleDOM(container, lang)
    return container.innerHTML
  }, [html, lang])
}

export const WikipediaItem = memo(({ id }: TapestryItemProps) => {
  const dto = useTapestryData(`items.${id}.dto`) as WebpageItemDto
  const isEditMode = useTapestryData('interactionMode') === 'edit'
  const { source, lang = 'en', title } = WEB_SOURCE_PARSERS.wikipedia.parse(dto.source)

  const { data, loading, error, reload } = useAsync(
    async ({ signal }) => {
      if (!title) return { html: '', displayTitle: '', categories: [] }

      const [html, displayTitle, categories] = await Promise.all([
        fetchWikipediaArticleHTML(lang, title, signal),
        fetchWikipediaDisplayTitle(lang, title, signal),
        fetchWikipediaCategories(lang, title, signal),
      ])
      return { html, displayTitle, categories }
    },
    [lang, title],
  )

  const sanitizedHTML = useSanitizedArticle(data?.html, lang)
  const sanitizedTitle = useMemo(
    () => (data?.displayTitle ? DOMPurify.sanitize(data.displayTitle) : undefined),
    [data?.displayTitle],
  )

  const controls = buildToolbarMenu({ dto, isEdit: isEditMode })
  const { toolbar } = useItemToolbar(id, {
    items: [
      {
        element: (
          <IconButton
            icon="refresh"
            aria-label="Reload this article"
            onClick={() => reload(noop)}
          />
        ),
        tooltip: { side: 'bottom', children: 'Reload this article' },
      },
      'separator',
      {
        element: (
          <IconButton
            icon="open_in_new"
            aria-label="View on Wikipedia"
            onClick={() => window.open(source, '_blank', 'noopener,noreferrer')}
          />
        ),
        tooltip: { side: 'bottom', children: 'View on Wikipedia' },
      },
      'separator',
      ...controls,
    ],
  })

  return (
    <TapestryItem id={id} halo={toolbar}>
      {loading ? (
        <div className={styles.status}>
          <LoadingSpinner size="24px" />
        </div>
      ) : error || !sanitizedHTML ? (
        <div className={styles.status}>
          <Icon icon="error" style={{ fontSize: 32 }} />
          <Text>Couldn&apos;t load this article from Wikipedia.</Text>
        </div>
      ) : (
        <div className={styles.article}>
          {sanitizedTitle && (
            <h1 className={styles.title} dangerouslySetInnerHTML={{ __html: sanitizedTitle }} />
          )}
          <div dangerouslySetInnerHTML={{ __html: sanitizedHTML }} />
          {!!data?.categories.length && (
            <div className={styles.categories}>
              <Text variant="bodyXs">
                Categories:{' '}
                {data.categories.map((category, index) => (
                  <span key={category.title}>
                    {index > 0 && ' | '}
                    <a
                      href={`https://${lang}.wikipedia.org/wiki/${encodeURIComponent(
                        `Category:${category.title.replace(/ /g, '_')}`,
                      )}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {category.title}
                    </a>
                  </span>
                ))}
              </Text>
            </div>
          )}
        </div>
      )}
    </TapestryItem>
  )
})
