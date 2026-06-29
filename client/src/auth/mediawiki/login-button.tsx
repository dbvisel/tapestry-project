import { Button } from 'tapestry-core-client/src/components/lib/buttons/index'
import { auth } from '..'
import { MediaWikiAuthService } from './service'

export function MediaWikiLoginButton() {
  function login() {
    if (auth instanceof MediaWikiAuthService) {
      // Redirects the window to the wiki; resolves only after navigation starts.
      void auth.login()
    }
  }

  return <Button onClick={login}>Sign in with MediaWiki</Button>
}
