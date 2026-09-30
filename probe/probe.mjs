// Throwaway: exercise agent-add.ts against the agent at argv[2] with keys argv[3..] (passphrase "pw").
import fs from 'fs'
import ssh2 from 'ssh2'
import { addKeyToAgent, sendAgentRequest, removeIdentityRequest } from './agent-add.ts'
const agent = process.argv[2]
const mode = process.argv[3]
const files = process.argv.slice(4)
const list = () => new Promise((res) => { const a = ssh2.createAgent(agent); a.getIdentities((e, ks) => res(e ? 'ERR ' + e.message : (ks || []).map((k) => k.type + ' ' + (k.comment || '')))) })
for (const f of files) {
  const k = ssh2.utils.parseKey(fs.readFileSync(f), 'pw')
  if (mode === 'constrained') console.log(f, 'lifetime=5 ->', await addKeyToAgent(agent, k, f + ' (constrained)', { lifetimeSec: 5 }))
  if (mode === 'plain') console.log(f, 'plain ->', await addKeyToAgent(agent, k, f + ' (plain)'))
  if (mode === 'remove') console.log(f, 'remove ->', await sendAgentRequest(agent, removeIdentityRequest(k)))
}
console.log('list:', JSON.stringify(await list()))
