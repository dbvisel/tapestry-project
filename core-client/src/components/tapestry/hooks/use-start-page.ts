import { useSearchParams } from 'react-router'
import { Id, OptionalInt } from 'tapestry-core/src/data-format/schemas/common'

export function useStartPage(id: Id) {
  const [searchParams] = useSearchParams()
  if (id !== searchParams.get('focus')) {
    return undefined
  }

  const page = OptionalInt().safeParse(searchParams.get('page') ?? undefined).data

  return page ? page - 1 : page
}
