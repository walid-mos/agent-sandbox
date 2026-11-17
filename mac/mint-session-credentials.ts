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
	if (typeof value !== 'string' || !value || /\s/u.test(value)) throw new Error(`agent-sandbox: missing or invalid ${what}`)
	return value
}

function sessionBinding(): Record<string, unknown> {
	const binding: unknown = JSON.parse(readFileSync(BINDING_FILE, 'utf8'))
	return {
		domain: vaultApi(),
		identityId: requireString(nested(binding, 'clients', 'boats', 'identityId'), 'Agents Sandboxes identity'),
		projectId: requireString(nested(binding, 'projectId'), 'vault project'),
		environment: requireString(nested(binding, 'environment'), 'vault environment'),
		exports: nested(binding, 'exports'),
		clients: nested(binding, 'clients'),
		tools: nested(binding, 'tools'),
	}
}

function description(role: string, session: string): string {
	const sandbox = requireString(process.env.SANDBOX, 'SANDBOX')
	if (!['broker', 'session'].includes(role) || !session || /\s/u.test(session)) throw new Error('usage: mint-session-credentials.ts broker|session SESSION')
	return `agent-sandbox: ${sandbox} ${session} ${role}`
}

async function mint(): Promise<void> {
	const [role = '', session = ''] = process.argv.slice(2)
	const label = description(role, session)
	const binding = sessionBinding()
	const token = await machineToken()
	const identity = `${vaultApi()}/v1/auth/universal-auth/identities/${binding.identityId}`
	const settings = await call(token, 'GET', identity)
	if (settings.status !== HTTP_OK) throw new Error('agent-sandbox: cannot read the Agents Sandboxes identity')
	const clientId = requireString(nested(settings.json, 'identityUniversalAuth', 'clientId'), 'client ID')
	const minted = await call(token, 'POST', `${identity}/client-secrets`, { description: label, ttl: 0, numUsesLimit: 0 })
	if (minted.status !== HTTP_OK) throw new Error('agent-sandbox: cannot mint an Agents Sandboxes client secret')
	const credentials = {
		INFISICAL_API_URL: vaultApi(),
		INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: clientId,
		INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: requireString(nested(minted.json, 'clientSecret'), 'client secret'),
	}
	const secretId = requireString(nested(minted.json, 'clientSecretData', 'id'), 'client secret ID')
	const output = role === 'session' ? JSON.stringify({ credentials, binding }) :
		Object.entries(credentials).map(([name, value]) => `${name}=${value}`).join('\n')
	process.stdout.write(`${output}\n`)
	process.stderr.write(`agent-sandbox: minted client secret ${secretId} (${label})\n`)
}

try {
	await mint()
} catch {
	process.stderr.write('agent-sandbox: credential mint failed. Check the Mac machine login, binding and mint permission.\n')
	process.exitCode = 1
}
