import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, get } from 'node:http'
import { pathToFileURL } from 'node:url'
import { proxyResponseBody } from '../src/oauth-network.js'
import { openaiCodexSubscriptionProvider } from '../src/pi-ai-runtime.js'
const { PiAiAdapter } = await import(process.env.DSH_RUNTIME_ROOT
  ? pathToFileURL(`${process.env.DSH_RUNTIME_ROOT}/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`).href
  : '@deepseek-ai/dsh-llm-pi-ai')
const jwt = [ {alg:'none'}, {'https://api.openai.com/auth':{chatgpt_account_id:'test-only'}} ]
  .map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.')+'.test'
test('real truncated SSE passes through pi-ai and DSH as TRANSPORT, not PI_AI_ERROR',async()=>{
  const server=createServer((req,res)=>{
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.write('data: {"type":"response.created","response":{"id":"test"}}\n\n')
    setTimeout(()=>res.destroy(),20)
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const previous=globalThis.fetch
  globalThis.fetch=async(_input,init)=>{
    const incoming=await new Promise((resolve,reject)=>get(`http://127.0.0.1:${server.address().port}`,resolve).on('error',reject))
    return new Response(proxyResponseBody(incoming,init.signal),{headers:{'content-type':'text/event-stream'}})
  }
  try {
    const profiles=new Map([['openai-codex',{provider:'openai-codex',displayName:'test',piProvider:openaiCodexSubscriptionProvider(),configuredMaxTokens:new Map(),modelErrors:new Map(),transport:'sse',streamIdleTimeoutMs:10000}]])
    const adapter=new PiAiAdapter({profiles:()=>profiles,resolveApiKey:async()=>jwt})
    const chunks=[]
    for await(const chunk of adapter.stream({provider:'openai-codex',model:'gpt-5.6-luna',messages:[{role:'user',content:[{type:'text',text:'test'}]}]}))chunks.push(chunk)
    const reason=chunks.findLast(x=>x.type==='finish').reason
    assert.equal(reason.kind,'error')
    assert.equal(reason.failure.code,'TRANSPORT')
    assert.match(reason.failure.message,/ECONNRESET/)
  } finally {globalThis.fetch=previous;await new Promise(resolve=>server.close(resolve))}
})
