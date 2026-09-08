import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { managedIntegrationRuntime, codexManagedIntegrationConfig, ManagedIntegrationRuntimeError } from '../dist/adapters/managed-integrations.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cood-managed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['packages/a/payload', 'packages/a/runtime', 'personal']) mkdirSync(join(root,path), {recursive:true});
  const personal = join(root,'personal/SKILL.md'); writeFileSync(personal, 'original');
  const entry = { id:'a',name:'Review',harness:'Codex',kind:'skill',enabled:true,sourceSkillPaths:[personal],sourceSkillNames:['review'],payloadRelativePath:'packages/a/payload',skillRootRelativePaths:['packages/a/payload'],claudePluginRelativePath:'packages/a/runtime' };
  const manifest=join(root,'library.json');
  const save=(entries=[entry], revision='one')=>writeFileSync(manifest,JSON.stringify({version:1,revision,entries}));
  save(); return {root,entry,manifest,save,env:{COODE_MANAGED_INTEGRATIONS_PATH:manifest},personal};
}

test('owned lifecycle suppresses personal fallback without changing personal files', t=>{
  const f=fixture(t);
  let runtime=managedIntegrationRuntime('codex',f.env);
  assert.equal(runtime.skillRoots.length,1); assert.equal(runtime.disabledSkillPaths.length,1);
  const originalSignature=runtime.signature;
  f.entry.enabled=false; f.save(undefined,'two'); runtime=managedIntegrationRuntime('codex',f.env);
  assert.equal(runtime.skillRoots.length,0); assert.equal(runtime.disabledSkillPaths.length,1); assert.notEqual(runtime.signature,originalSignature);
  f.entry.removedAt=new Date().toISOString(); f.save(); runtime=managedIntegrationRuntime('codex',f.env);
  assert.equal(runtime.skillRoots.length,0); assert.equal(runtime.disabledSkillPaths.length,1);
  assert.equal(readFileSync(f.personal,'utf8'),'original');
  assert.equal(managedIntegrationRuntime('codex',{}),undefined);
});

test('provider configuration preserves unrelated rules and agent isolation',t=>{
  const f=fixture(t); f.entry.sourcePluginID='original@personal';f.save();
  assert.equal(managedIntegrationRuntime('claude',f.env),undefined);
  const config=codexManagedIntegrationConfig(managedIntegrationRuntime('codex',f.env),{skills:{config:[{path:'/other/SKILL.md',enabled:false}]},plugins:{'other@personal':{enabled:true}}});
  assert.equal(config.skills.config.length,2);assert.deepEqual(config.plugins,{'other@personal':{enabled:true},'original@personal':{enabled:false}});
});

test('Claude runs an isolated namespace and suppresses imported originals even after removal',t=>{
  const f=fixture(t);f.entry.harness='Claude';f.save();
  const runtime=managedIntegrationRuntime('claude',f.env);
  assert.equal(runtime.claudeArguments[0],'--plugin-dir');
  assert.deepEqual(JSON.parse(runtime.claudeArguments.at(-1)),{skillOverrides:{review:'off'}});
  f.entry.enabled=false;f.entry.removedAt='2026-09-06T00:00:00Z';f.save();
  assert.deepEqual(managedIntegrationRuntime('claude',f.env).claudeArguments,['--settings','{"skillOverrides":{"review":"off"}}']);
});

test('invalid manifests, escaped payloads, and duplicate IDs fail closed',t=>{
  const f=fixture(t);
  f.save([f.entry,f.entry]);assert.throws(()=>managedIntegrationRuntime('codex',f.env),ManagedIntegrationRuntimeError);
  f.entry.skillRootRelativePaths=['packages/../../personal'];f.save();assert.throws(()=>managedIntegrationRuntime('codex',f.env),ManagedIntegrationRuntimeError);
  f.entry.skillRootRelativePaths=['packages/escape'];symlinkSync(tmpdir(),join(f.root,'packages/escape'));f.save();assert.throws(()=>managedIntegrationRuntime('codex',f.env),ManagedIntegrationRuntimeError);
  writeFileSync(f.manifest,'broken');assert.throws(()=>managedIntegrationRuntime('codex',f.env),ManagedIntegrationRuntimeError);
});
