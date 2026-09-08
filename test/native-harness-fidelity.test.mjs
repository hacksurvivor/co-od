import { zeroClawAgentAlias } from '../dist/adapters/zeroclaw.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureSession, executeAcpAgent } from '../dist/adapters/acp.js';
import { nativeImageAttachments } from '../dist/adapters/native-images.js';
import { buildClaudeArgs, claudeUserInput } from '../dist/adapters/claude.js';
import { buildAntigravityArgs } from '../dist/adapters/antigravity.js';
import coodePermissions from '../dist/adapters/pi-permission-extension.js';
import { DEFAULT_CODEX_TURN_TIMEOUT_MS } from '../dist/adapters/codex-app-server.js';

const model = { id:'model', name:'Model', category:'model', type:'select', currentValue:'small', options:[{value:'small',name:'Small'},{value:'large',name:'Large'}] };
const effort = { id:'effort', name:'Reasoning effort', category:'thought_level', type:'select', currentValue:'low', options:[{value:'low',name:'Low'},{value:'high',name:'High'}] };

test('ACP applies exact selected model and then uses its refreshed effort catalog', async () => {
 const calls=[];
 const updatedEffort={...effort,options:[{value:'ultra',name:'Ultra'}]};
 const context={request:async(method,params)=>{calls.push([method,params]);return {configOptions:[{...model,currentValue:'large'},updatedEffort]};}};
 await configureSession(context,{sessionID:'session',configOptions:[{...model,id:'context',category:'model_config',options:[]},model,effort]},{model:'large',effort:'ultra'},'fixture');
 assert.deepEqual(calls.map(([,p])=>[p.configId,p.value]),[['model','large'],['effort','ultra']]);
});

test('ACP cannot silently substitute a model or effort or mistake context size for the model',async()=>{
 const context={request:async()=>assert.fail('must not dispatch a mismatched selection')};
 for(const [configOptions,options] of [[[model],{model:'missing'}],[[effort],{effort:'ultra'}],[[],{model:'large'}],[[{...model,id:'context_size',name:'Context size',category:'model_config'}],{model:'large'}]]) {
  await assert.rejects(configureSession(context,{sessionID:'s',configOptions},options,'fixture'),/not advertise|does not expose/);
 }
});

test('ACP preserves native legacy model selection on installed agents',async()=>{
 const calls=[];const context={request:async(method,params)=>{calls.push([method,params]);return {};}};
 await configureSession(context,{sessionID:'s',models:{currentModelId:'small',availableModels:[{modelId:'large',name:'Large'}]}},{model:'Large'},'hermes');
 assert.deepEqual(calls,[['session/set_model',{sessionId:'s',modelId:'large'}]]);
});

test('image bytes reach ACP and Claude native inputs without being rewritten',async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'coode-images-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'test.png');const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');await writeFile(path,bytes);
 const attachments=[{path:'test.png',absolutePath:path,kind:'image',exists:true}];
 const images=await nativeImageAttachments(attachments);assert.equal(images[0].data,bytes.toString('base64'));assert.equal(images[0].mimeType,'image/png');
 const input=JSON.parse(claudeUserInput('Что на картинке?',undefined,images));assert.equal(input.message.content[1].source.data,images[0].data);
 assert.ok(buildClaudeArgs('Что на картинке?',{nativeInput:true}).includes('--input-format'));
 assert.ok(!buildClaudeArgs('Что на картинке?',{nativeInput:true}).includes('Что на картинке?'));
 const raw=[];const result=await executeAcpAgent({executable:process.execPath,args:[decodeURIComponent(new URL('./fixtures/acp-agent.mjs',import.meta.url).pathname)],harness:'fixture'},'Что на картинке?',{workDir:root,attachments,permissionMode:'approve',onRawEvent:event=>raw.push(event)});
 assert.equal(result.exitCode,0,result.stderr);const prompt=raw.find(event=>event.payload?.method==='session/prompt').payload.params.prompt;
 assert.deepEqual(prompt[1],images[0]);assert.ok(prompt[0].text.endsWith('Что на картинке?'));
});

test('Antigravity forwards user-selected permissions effort and workspace roots',()=>{
 assert.deepEqual(buildAntigravityArgs('work',{permissionMode:'fullAccess',effort:'high',additionalDirectories:['/tmp/one','/tmp/one']}),['--dangerously-skip-permissions','--effort','high','--add-dir','/tmp/one','--print','work']);
 assert.deepEqual(buildAntigravityArgs('plan',{permissionMode:'plan'}),['--sandbox','--mode','plan','--print','plan']);
 assert.deepEqual(buildAntigravityArgs('ask',{permissionMode:'ask'}),['--print','ask']);
 assert.equal(DEFAULT_CODEX_TURN_TIMEOUT_MS,0,'native Codex turns must not be stopped after an arbitrary duration');
});

test('Pi native permission hook retains reads and gates mutation without disabling tools',async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'coode-pi-policy-'));t.after(()=>rm(root,{recursive:true,force:true}));let mode='ask',handler;const dialogs=[];let confirmed=false;
 coodePermissions({registerFlag:()=>{},getFlag:()=>mode,on:(_,fn)=>handler=fn});
 const ctx={cwd:root,hasUI:true,ui:{confirm:async(...args)=>{dialogs.push(args);return confirmed;}}};
 assert.equal(await handler({toolName:'read',input:{path:'README.md'}},ctx),undefined);assert.equal(dialogs.length,0);
 assert.equal((await handler({toolName:'bash',input:{command:'echo hi'}},ctx)).block,true);assert.equal(dialogs.length,1);
 confirmed=true;assert.equal(await handler({toolName:'bash',input:{command:'echo hi'}},ctx),undefined);
 mode='plan';assert.equal((await handler({toolName:'edit',input:{path:'README.md'}},ctx)).block,true);
 mode='approve';assert.equal(await handler({toolName:'write',input:{path:'new.md'}},ctx),undefined);
 const outside=join(root,'outside');await mkdir(outside);const workspace=join(root,'workspace');await mkdir(workspace);await symlink(join(outside,'missing'),join(workspace,'link'));confirmed=false;
 assert.equal((await handler({toolName:'write',input:{path:'link'}},{...ctx,cwd:workspace})).block,true,'broken symlinks must not auto-approve writes outside the workspace');
 assert.equal((await handler({toolName:'custom_tool',input:{}},{...ctx,hasUI:false})).block,true);
});


test('Grok legacy effort and OpenCode config-option Plan transitions stay native', async () => {
 const calls=[];const context={request:async(method,params)=>{calls.push([method,params]);return {};}};
 await configureSession(context,{sessionID:'grok',models:{currentModelId:'grok-4.6',availableModels:[{modelId:'grok-4.5',name:'Grok 4.5',_meta:{reasoningEfforts:[{id:'high',value:'high'}]}}]}},{model:'grok-4.5',effort:'high',permissionMode:'plan'},'grok');
 assert.deepEqual(calls,[['session/set_mode',{sessionId:'grok',modeId:'plan'}],['session/set_model',{sessionId:'grok',modelId:'grok-4.5'}],['session/set_model',{sessionId:'grok',modelId:'grok-4.5',_meta:{reasoningEffort:'high'}}]]);
 calls.length=0;
 await configureSession(context,{sessionID:'open',configOptions:[{id:'mode',name:'Session Mode',category:'mode',type:'select',currentValue:'plan',options:[{value:'build',name:'build'},{value:'plan',name:'plan'}]}]},{permissionMode:'fullAccess'},'opencode');
 assert.deepEqual(calls,[['session/set_config_option',{sessionId:'open',configId:'mode',value:'build'}]]);
});


test('legacy models survive the ACP SDK response decoder and reach the actual provider session', async () => {
 const result=await executeAcpAgent({executable:process.execPath,args:[decodeURIComponent(new URL('./fixtures/acp-agent.mjs',import.meta.url).pathname),'--legacy-models'],harness:'hermes'},'Проверь проект',{workDir:process.cwd(),model:'fixture-large',permissionMode:'approve'});
 assert.equal(result.exitCode,0,result.stderr);assert.equal(result.stdout,'fixture-large');
});


test('ACP token limits preserve partial output without reporting task completion', async () => {
 const result=await executeAcpAgent({executable:process.execPath,args:[decodeURIComponent(new URL('./fixtures/acp-agent.mjs',import.meta.url).pathname),'--token-limit'],harness:'fixture'},'Do the work',{workDir:process.cwd(),permissionMode:'approve'});
 assert.equal(result.exitCode,1);assert.equal(result.stdout,'ACP ready');assert.match(result.stderr,/native turn limit/);assert.equal(result.providerSessionId,'acp-session-new');
});


test('ZeroClaw selects the configured native agent without guessing among aliases', () => {
 assert.equal(zeroClawAgentAlias({value:{researcher:{}}},''),'researcher');
 assert.equal(zeroClawAgentAlias({value:{researcher:{},coder:{}}},'coder'),'coder');
 assert.throws(()=>zeroClawAgentAlias({value:{researcher:{},coder:{}}},''),/multiple configured/);
 assert.throws(()=>zeroClawAgentAlias({value:{}},''),/requires a configured agent/);
});
