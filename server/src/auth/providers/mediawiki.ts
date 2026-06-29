import z from 'zod/v4'
import { SessionCreateDto } from 'tapestry-shared/src/data-transfer/resources/dtos/session.js'
import { AuthProvider } from './index.js'
import { config } from '../../config.js'
import { InvalidCredentialsError, ServerError } from '../../errors/index.js'
import { updateUserIfExists } from '../index.js'
import { RegisterJWTData } from '../tokens.js'

// MediaWiki OAuth 2.0 (authorization-code) flow. Unlike ORCID, the MediaWiki token endpoint
// returns only an opaque access token, so we make a second, authenticated call to the userinfo
// endpoint (oauth2/resource/profile) to obtain the authenticated user's identity.
// See https://www.mediawiki.org/wiki/OAuth/For_Developers
const MediaWikiTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
})

// `sub` is the stable central user id (an integer); the username can change over time, so we
// key the account on `sub`. `email` is only present when the user has a confirmed address and
// the consumer was granted access to it.
const MediaWikiProfileSchema = z.object({
  sub: z.coerce.string(),
  username: z.string(),
  email: z.string().nullish(),
  confirmed_email: z.boolean().nullish(),
  realname: z.string().nullish(),
})

async function fetchMediaWikiProfile(code: string, redirectUri: string): Promise<RegisterJWTData> {
  let profile: z.infer<typeof MediaWikiProfileSchema>

  try {
    const tokenResponse = await fetch(`${config.server.mediawiki.baseUrl}/oauth2/access_token`, {
      method: 'post',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: config.server.mediawiki.clientId,
        client_secret: config.server.mediawiki.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    })

    if (!tokenResponse.ok) {
      throw new InvalidCredentialsError()
    }

    const { access_token: accessToken } = MediaWikiTokenResponseSchema.parse(
      await tokenResponse.json(),
    )

    const profileResponse = await fetch(
      `${config.server.mediawiki.baseUrl}/oauth2/resource/profile`,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      },
    )

    if (!profileResponse.ok) {
      throw new InvalidCredentialsError()
    }

    profile = MediaWikiProfileSchema.parse(await profileResponse.json())
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      throw error
    }
    console.error('Error while performing MediaWiki authentication', error)
    throw new ServerError()
  }

  const { sub, username, email, confirmed_email: confirmedEmail, realname } = profile

  return {
    mediawikiId: sub,
    // Use the real address only when the wiki confirms it; otherwise synthesize a stable,
    // unique placeholder from the central user id to satisfy the User model.
    email: email && confirmedEmail ? email : `${sub}@mediawiki.invalid`,
    givenName: realname?.trim() || username,
    familyName: '',
    avatar: null,
  }
}

type MediaWikiCredentials = SessionCreateDto & { authType: 'mediawiki' }

export class MediaWikiAuthProvider implements AuthProvider<MediaWikiCredentials> {
  async login({ code, redirectUri }: MediaWikiCredentials) {
    const userData = await fetchMediaWikiProfile(code, redirectUri)

    return updateUserIfExists({ mediawikiId: userData.mediawikiId }, userData)
  }
}
