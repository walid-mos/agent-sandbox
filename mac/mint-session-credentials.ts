import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { pathToFileURL } from 'node:url'

const security = `${process.env.PI_CODING_AGENT_DIR ?? `${homedir()}/.pi/agent`}/security`
const { call, HTTP_OK } = await import(pathToFileURL(`${security}/infisical-rest.ts`).href)
const { machineToken, vaultApi } = await import(pathToFileURL(`${security}/machine-identity.ts`).href)

const BINDING_FILE = `${homedir()}/.config/agent-secrets/core-vault.json`

function nested(source: unknown, ...keys: string[]): unknown {
	return keys.reduce<unknown>(
		(value, key) => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined),
		source,
	)
}

function requireString(value: unknown, what: string): string {
	if (typeof value !== 'string' || !value) throw new Error(`agent-sandbox: the vault returned no ${what}`)
	return value
}

function sandboxIdentityId(): string {
	const binding: unknown = JSON.parse(readFileSync(BINDING_FILE, 'utf8'))
	return requireString(nested(binding, 'clients', 'boats', 'identityId'), `Agents Sandboxes identity in ${BINDING_FILE}`)
}

function description(): string {
	const sandbox = process.env.SANDBOX
	if (!sandbox) throw new Error('agent-sandbox: set SANDBOX to the sandbox whose session receives the credential')
	return `agent-sandbox: ${sandbox} session`
}

async function mint(): Promise<void> {
	const token = await machineToken()
	const identity = `${vaultApi()}/v1/auth/universal-auth/identities/${sandboxIdentityId()}`
	const settings = await call(token, 'GET', identity)
	if (settings.status !== HTTP_OK) throw new Error(`agent-sandbox: reading the Agents Sandboxes identity answered HTTP ${settings.status}`)
	const clientId = requireString(nested(settings.json, 'identityUniversalAuth', 'clientId'), 'client ID')
	const minted = await call(token, 'POST', `${identity}/client-secrets`, { description: description(), ttl: 0, numUsesLimit: 0 })
	if (minted.status !== HTTP_OK) throw new Error(`agent-sandbox: minting an Agents Sandboxes client secret answered HTTP ${minted.status}`)
	const clientSecret = requireString(nested(minted.json, 'clientSecret'), 'client secret')
	const secretId = requireString(nested(minted.json, 'clientSecretData', 'id'), 'client secret ID')
	process.stdout.write(
		`INFISICAL_API_URL=${vaultApi()}\nINFISICAL_UNIVERSAL_AUTH_CLIENT_ID=${clientId}\nINFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=${clientSecret}\n`,
	)
	process.stderr.write(`agent-sandbox: minted Agents Sandboxes client secret ${secretId} (${description()})\n`)
}

await mint()
