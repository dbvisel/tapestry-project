import { useAsyncAction } from 'tapestry-core-client/src/components/lib/hooks/use-async-action'
import { resource } from '../services/rest-resources'
import { LoadingSpinner } from 'tapestry-core-client/src/components/lib/loading-spinner'
import { ToolbarElement } from 'tapestry-core-client/src/components/lib/toolbar'
import { IconButton } from 'tapestry-core-client/src/components/lib/buttons'

export function useConvertToPDF(id: string) {
  const { trigger, loading, data } = useAsyncAction(({ signal }) =>
    resource('items').update({ id }, { type: 'pdf' }, undefined, { signal }),
  )

  const conversionStarted = loading || !!data

  return {
    convertToPDF: trigger,
    conversionStarted,
    convertToPDFToolbarElement: {
      element: conversionStarted ? (
        <LoadingSpinner style={{ alignSelf: 'center' }} size="16px" />
      ) : (
        <IconButton icon="picture_as_pdf" aria-label="Convert to PDF" onClick={trigger} />
      ),
      tooltip: { side: 'bottom', children: 'Convert to PDF' },
    } satisfies ToolbarElement,
  }
}
