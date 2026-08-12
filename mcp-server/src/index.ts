import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { ItemCreateDto } from 'tapestry-shared/src/data-transfer/resources/dtos/item.js'
import { TapestryApiClient } from './api-client.js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

const client = new TapestryApiClient({
  baseUrl: process.env.TAPESTRY_API_URL ?? 'http://localhost:3000/api',
  viewerUrl: process.env.TAPESTRY_VIEWER_URL ?? 'http://localhost:8080',
  email: requireEnv('TAPESTRY_IA_EMAIL'),
  password: requireEnv('TAPESTRY_IA_PASSWORD'),
})

const server = new McpServer({ name: 'tapestry', version: '0.1.0' })

function textResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  }
}

server.registerTool(
  'list_tapestries',
  {
    title: 'List my tapestries',
    description: 'Lists the Tapestries owned by the logged-in Tapestry (Internet Archive) account.',
    inputSchema: {},
  },
  async () => {
    try {
      const { data, total } = await client.listMyTapestries()
      return textResult({
        total,
        tapestries: data.map((t) => ({
          id: t.id,
          title: t.title,
          slug: t.slug,
          visibility: t.visibility,
          updatedAt: t.updatedAt,
        })),
      })
    } catch (error) {
      return errorResult(error)
    }
  },
)

server.registerTool(
  'get_tapestry',
  {
    title: 'Get a tapestry',
    description:
      'Fetches a tapestry, including its items and the relations (rels) between them. This is the closest ' +
      'equivalent to "downloading" it - Tapestry\'s own zip export format is only implemented client-side ' +
      "in the browser, so this returns the tapestry's data as JSON instead of a re-importable .zip file.",
    inputSchema: {
      id: z.string().describe('The tapestry id (see list_tapestries).'),
    },
  },
  async ({ id }) => {
    try {
      return textResult(await client.getTapestry(id))
    } catch (error) {
      return errorResult(error)
    }
  },
)

server.registerTool(
  'create_tapestry',
  {
    title: 'Create a tapestry',
    description:
      'Creates a new, empty Tapestry canvas owned by the logged-in account. Use add_item afterward to ' +
      'populate it with content.',
    inputSchema: {
      title: z.string().nonempty().describe('The title of the new tapestry.'),
      description: z.string().optional().describe('An optional description.'),
      visibility: z
        .enum(['private', 'link'])
        .optional()
        .describe(
          '"private" (default): only the owner can see it. "link": anyone with the link can view it.',
        ),
    },
  },
  async (params) => {
    try {
      const tapestry = await client.createTapestry(params)
      return textResult({
        id: tapestry.id,
        title: tapestry.title,
        slug: tapestry.slug,
        visibility: tapestry.visibility,
        url: await client.viewUrl(tapestry.slug),
      })
    } catch (error) {
      return errorResult(error)
    }
  },
)

// Deliberately narrow for this proof of concept: the full picker/URL-classification logic that decides
// what kind of item a pasted link becomes (Wikipedia, Commons, Openverse, IIIF, ...) lives client-side in
// item-factories.ts and isn't reimplemented here. These three cover plain text, embedding a webpage, and a
// direct image URL - already enough to prove out agent-driven content creation.
const ITEM_DEFAULT_SIZE = {
  text: { width: 400, height: 200 },
  webpage: { width: 400, height: 500 },
  image: { width: 400, height: 300 },
} as const

server.registerTool(
  'add_item',
  {
    title: 'Add an item to a tapestry',
    description:
      'Adds a single item to an existing tapestry: a text frame, an embedded webpage (iframed), or an ' +
      'image (given its direct URL).',
    inputSchema: {
      tapestryId: z
        .string()
        .describe('The tapestry to add the item to (see list_tapestries/create_tapestry).'),
      type: z.enum(['text', 'webpage', 'image']),
      text: z
        .string()
        .optional()
        .describe('Required (and only used) when type is "text": the HTML content.'),
      source: z
        .string()
        .optional()
        .describe(
          'Required (and only used) when type is "webpage" or "image": the URL to embed/display.',
        ),
      title: z
        .string()
        .optional()
        .describe('Optional title label shown near the item on the canvas.'),
      x: z.number().optional().describe('Canvas x position in pixels. Defaults to 0.'),
      y: z.number().optional().describe('Canvas y position in pixels. Defaults to 0.'),
      width: z
        .number()
        .optional()
        .describe('Item width in pixels. Defaults to a sensible size per type.'),
      height: z
        .number()
        .optional()
        .describe('Item height in pixels. Defaults to a sensible size per type.'),
    },
  },
  async ({ tapestryId, type, text, source, title, x, y, width, height }) => {
    try {
      const base = {
        tapestryId,
        position: { x: x ?? 0, y: y ?? 0 },
        size: {
          width: width ?? ITEM_DEFAULT_SIZE[type].width,
          height: height ?? ITEM_DEFAULT_SIZE[type].height,
        },
        dropShadow: true,
        title,
      }

      let item: ItemCreateDto
      if (type === 'text') {
        if (!text) throw new Error('"text" is required when type is "text"')
        item = { ...base, type: 'text', text }
      } else if (type === 'webpage') {
        if (!source) throw new Error('"source" is required when type is "webpage"')
        item = { ...base, type: 'webpage', source }
      } else {
        if (!source) throw new Error('"source" is required when type is "image"')
        item = { ...base, type: 'image', source }
      }

      return textResult(await client.addItem(item))
    } catch (error) {
      return errorResult(error)
    }
  },
)

await server.connect(new StdioServerTransport())
