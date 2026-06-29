import { NullishInt } from 'tapestry-core/src/data-format/schemas/common'
import { deepFreeze } from 'tapestry-core/src/utils'
import { treeifyError, z } from 'zod/v4'

const parsedConfig = deepFreeze(
  z
    .object({
      VITE_API_URL: z.string(),
      VITE_AUTH_PROVIDER: z.enum(['ia', 'google', 'mediawiki']).catch('google'),
      VITE_GOOGLE_CLIENT_ID: z.string(),
      VITE_MEDIAWIKI_CLIENT_ID: z.string().default(''),
      VITE_MEDIAWIKI_BASE_URL: z.string().default('https://meta.wikimedia.org/w/rest.php'),
      // Optional override for the OAuth callback URL. Must match a redirect URI registered
      // with the wiki's OAuth consumer. Defaults to the app's own origin at runtime when blank.
      VITE_MEDIAWIKI_REDIRECT_URI: z.string().default(''),
      VITE_BUG_REPORT_FORM_URL: z.string(),
      VITE_AI_CHAT_EXPIRES_IN: NullishInt(3600), // default: one hour
      VITE_WEBPAGE_LOADER_TIMEOUT: NullishInt(3, (schema) => schema.nonnegative()),
      VITE_WBM_SNAPSHOT_POLLING_PERIOD: NullishInt(600), // default: ten minutes
      VITE_STUN_SERVER: z.string(),
      VITE_SENTRY_DSN: z.string().default(''),
    })
    .transform((input) => ({
      apiUrl: input.VITE_API_URL,
      authProvider: input.VITE_AUTH_PROVIDER,
      googleClientId: input.VITE_GOOGLE_CLIENT_ID,
      mediawiki: {
        clientId: input.VITE_MEDIAWIKI_CLIENT_ID,
        baseUrl: input.VITE_MEDIAWIKI_BASE_URL,
        redirectUri: input.VITE_MEDIAWIKI_REDIRECT_URI,
      },
      bugReportFormUrl: input.VITE_BUG_REPORT_FORM_URL,
      aiChatExpiresIn: input.VITE_AI_CHAT_EXPIRES_IN,
      webpageLoaderTimeout: input.VITE_WEBPAGE_LOADER_TIMEOUT,
      wbmSnapshotPollingPeriod: input.VITE_WBM_SNAPSHOT_POLLING_PERIOD,
      stunServer: input.VITE_STUN_SERVER,
      sentryDsn: input.VITE_SENTRY_DSN,
    }))
    .safeParse(import.meta.env),
)

if (parsedConfig.error) {
  console.error('Error in config', treeifyError(parsedConfig.error))
  throw parsedConfig.error
}

export const config = parsedConfig.data
