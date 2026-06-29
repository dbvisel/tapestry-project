import { LoginWithMediaWikiDto } from 'tapestry-shared/src/data-transfer/resources/dtos/session'
import { config } from '../../config'
import { AuthService } from '../../services/auth'
import { CanceledError, GenericAbortSignal } from 'axios'

/**
 * MediaWiki uses a standard OAuth2 authorization-code flow (like ORCID, unlike Google's in-page
 * popup):
 *  1. We redirect the whole window to the wiki's oauth2/authorize endpoint.
 *  2. The wiki redirects back to our `redirectUri` with a `?code=...` query parameter.
 *  3. We hand that code to our server, which exchanges it for an access token and then fetches
 *     the authenticated user's profile.
 *
 * See https://www.mediawiki.org/wiki/OAuth/For_Developers
 */
function redirectUri() {
  return config.mediawiki.redirectUri || `${window.location.origin}/`
}

export class MediaWikiAuthService extends AuthService<LoginWithMediaWikiDto> {
  /** Step 1: send the user to the wiki to authenticate. */
  login() {
    const authorizeUrl = new URL(`${config.mediawiki.baseUrl}/oauth2/authorize`)
    authorizeUrl.search = new URLSearchParams({
      client_id: config.mediawiki.clientId,
      response_type: 'code',
      redirect_uri: redirectUri(),
    }).toString()

    window.location.assign(authorizeUrl.toString())
    return Promise.resolve()
  }

  /**
   * Step 3: when the app loads after the MediaWiki redirect, the URL carries the `code`.
   * Exchange it for a session here so it runs on the normal startup refresh path.
   */
  async refresh(loadUser?: boolean, signal?: GenericAbortSignal) {
    const url = new URL(window.location.href)
    const code = url.searchParams.get('code')

    if (code) {
      // Remove the OAuth params from the URL so a reload doesn't try to reuse a spent code.
      const dirtyParams = ['code', 'error', 'error_description', 'state']
      dirtyParams.forEach((param) => url.searchParams.delete(param))
      window.history.replaceState({}, '', url.toString())

      try {
        await this.doLogin(
          { authType: 'mediawiki', code, redirectUri: redirectUri() },
          true,
          signal,
        )
        return
      } catch (error) {
        if (error instanceof CanceledError) {
          throw error
        }
        // Fall through to a normal refresh-token attempt if the exchange failed.
      }
    }

    await super.refresh(loadUser, signal)
  }
}
