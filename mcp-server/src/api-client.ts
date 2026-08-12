import {
  LoginWithIACredentialsDto,
  SessionCreateDto,
  SessionDto,
} from 'tapestry-shared/src/data-transfer/resources/dtos/session.js'
import {
  TapestryCreateDto,
  TapestryDto,
} from 'tapestry-shared/src/data-transfer/resources/dtos/tapestry.js'
import { ItemCreateDto, ItemDto } from 'tapestry-shared/src/data-transfer/resources/dtos/item.js'
import { ListResponseDto } from 'tapestry-shared/src/data-transfer/resources/dtos/common.js'

export interface TapestryApiClientOptions {
  /** e.g. "http://localhost:3000/api" */
  baseUrl: string
  /** e.g. "http://localhost:8080" - used only to build human-viewable tapestry links. */
  viewerUrl: string
  /** Internet Archive account email/password - the only non-interactive login path Tapestry supports today. */
  email: string
  password: string
}

// Refresh the access token this long before it actually expires, so a slow request doesn't race the
// 5-minute JWT expiry.
const REFRESH_MARGIN_MS = 30_000

/**
 * A minimal client for the Tapestry REST API, authenticating as a single Internet Archive account.
 *
 * There is no personal-access-token/API-key concept in Tapestry today - only interactive Google/IA-cookie
 * login, or IA username+password (`authType: 'iaCredentials'`), which is the only login path usable
 * without a browser. This client logs in once, then transparently refreshes the resulting short-lived
 * (5 min) access token using the httpOnly refresh-token cookie Tapestry issues alongside it - which a
 * server-side Node client has to manage manually, since (unlike a browser) `fetch` here doesn't keep a
 * cookie jar for us.
 */
export class TapestryApiClient {
  private accessToken: string | undefined
  private expiresAt = 0
  private refreshCookie: string | undefined
  private userId: string | undefined
  private username: string | undefined
  private authPromise: Promise<void> | undefined

  constructor(private readonly options: TapestryApiClientOptions) {}

  private async postSession(body: SessionCreateDto, cookie?: string): Promise<SessionDto> {
    const url = new URL(`${this.options.baseUrl}/sessions`)
    // The API's `include` param is validated as an array (`z.string().array()`), so a bare `include=user`
    // fails validation - it needs the bracketed array form `include[]=user`.
    url.searchParams.set('include[]', 'user')

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`Tapestry login failed (${response.status}): ${await response.text()}`)
    }

    // Node's fetch has no cookie jar, so the refresh-token cookie Tapestry sets on login has to be
    // captured and resent manually on the next refresh call.
    const setRefreshCookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith('refreshToken='))
    if (setRefreshCookie) {
      this.refreshCookie = setRefreshCookie.split(';')[0]
    }

    const session = (await response.json()) as SessionDto
    this.accessToken = session.accessToken
    this.expiresAt = session.expiresAt
    this.userId = session.userId
    this.username = session.user?.username ?? this.username
    return session
  }

  private async login(): Promise<void> {
    const credentials: LoginWithIACredentialsDto = {
      authType: 'iaCredentials',
      email: this.options.email,
      password: this.options.password,
    }
    await this.postSession(credentials)
  }

  private async refreshOrLogin() {
    if (!this.refreshCookie) {
      await this.login()
      return
    }
    try {
      await this.postSession({ authType: 'refreshToken' }, this.refreshCookie)
    } catch {
      // The refresh-token cookie is itself only valid for 1 day - fall back to a fresh login if it's gone.
      await this.login()
    }
  }

  /** Ensures a valid access token, logging in or refreshing at most once even under concurrent calls. */
  private async ensureAuthenticated(): Promise<string> {
    if (!this.accessToken || Date.now() > this.expiresAt - REFRESH_MARGIN_MS) {
      this.authPromise ??= (this.accessToken ? this.refreshOrLogin() : this.login()).finally(() => {
        this.authPromise = undefined
      })
      await this.authPromise
    }
    return this.accessToken!
  }

  private async request<T>(
    method: string,
    path: string,
    { body, query }: { body?: unknown; query?: Record<string, string | string[]> } = {},
  ): Promise<T> {
    const accessToken = await this.ensureAuthenticated()
    const url = new URL(`${this.options.baseUrl}/${path}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      // Array-typed query params (e.g. `include`) are validated as arrays server-side, so each entry needs
      // its own `key[]=` param rather than one comma-joined string.
      for (const entry of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(Array.isArray(value) ? `${key}[]` : key, entry)
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      throw new Error(
        `Tapestry API request failed (${method} ${path} -> ${response.status}): ${await response.text()}`,
      )
    }

    return (await response.json()) as T
  }

  /** A human-viewable link to a tapestry, e.g. for surfacing back to whoever asked the agent to create one. */
  async viewUrl(slug: string): Promise<string> {
    await this.ensureAuthenticated()
    return `${this.options.viewerUrl}/u/${this.username}/${slug}`
  }

  /** Tapestries owned by the logged-in user. */
  async listMyTapestries(limit = 50): Promise<ListResponseDto<TapestryDto>> {
    await this.ensureAuthenticated()
    return this.request('GET', 'tapestries', {
      query: { 'filter[ownerId:eq]': this.userId!, limit: String(limit) },
    })
  }

  /** A single tapestry with its items and rels included - the closest equivalent to "downloading" it. */
  async getTapestry(id: string): Promise<TapestryDto> {
    return this.request('GET', `tapestries/${id}`, {
      query: { include: ['items', 'rels'] },
    })
  }

  async createTapestry(params: {
    title: string
    description?: string
    visibility?: 'private' | 'link'
  }): Promise<TapestryDto> {
    const body: TapestryCreateDto = {
      title: params.title,
      description: params.description,
      visibility: params.visibility ?? 'private',
      theme: 'light',
      background: '#f5f5f0',
      items: [],
      rels: [],
    }
    return this.request('POST', 'tapestries', { body })
  }

  async addItem(item: ItemCreateDto): Promise<ItemDto> {
    return this.request('POST', 'items', { body: item })
  }
}
