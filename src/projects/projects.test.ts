import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createProjectSchema, updateProjectSchema, manualMemorySchema, memoryInputSchema, projectDtoSchema, submissionContextSchema } from './contracts.js';
import { memoryHash } from './store.js';
import { assembleProjectContext, resolveProjectRepository, planProjectGoal } from './context.js';
import type { ProjectStore } from './store.js';
import { rankMemories, memoryScore } from '../memory/retrieval.js';
import type { MemoryDto, ProjectDto } from './contracts.js';
import { submitDecision } from '../chief/submit-decision.js';
import { createFixtureStore, fixtureTaskId } from '../control-plane/fixtures.js';
import { projectTaskOutcome } from '../memory/outcome-sync.js';
import { delegate } from '../control-plane/mutations.js';
import { projectApi } from '../control-plane/project-api.js';
import { EmbeddingError } from '../memory/embedding.js';
const projectId=randomUUID(), otherId=randomUUID(), repoId=randomUUID(), now='2026-10-02T10:00:00.000Z';
function project(): ProjectDto {return projectDtoSchema.parse({id:projectId,slug:'investi',name:'Investi',status:'active',description:'Finance application',goals:'Build market data',constraints:'Local privacy',instructions:'Use server-only services',currentMilestone:'Portfolio Lab',createdAt:now,updatedAt:now,repositories:[{repositoryId:repoId,key:'a'.repeat(24),name:'investi',role:'app',isPrimary:true}],recentTasks:[]});}
function memory(overrides: Partial<MemoryDto> = {}): MemoryDto {return {id:randomUUID(),projectId,kind:'architecture',title:'Market data',content:'MarketDataService is server-only',importance:2,sourceType:'manual',sourceId:null,sourceMetadata:{input:'explicit_human'},contentHash:'hash',embeddingModel:'fake',indexed:true,embeddingError:null,createdAt:now,updatedAt:now,...overrides};}
test('project validation accepts fields and rejects multiple primaries/duplicates/paths/oversize fields', () => {
  assert.equal(createProjectSchema.parse({name:'Investi'}).status,'active');assert.equal(updateProjectSchema.parse({status:'archived'}).status,'archived');
  for(const v of [{name:'x',repositories:[{repositoryId:repoId,isPrimary:true},{repositoryId:randomUUID(),isPrimary:true}]},{name:'x',repositories:[{repositoryId:repoId},{repositoryId:repoId}]},{name:'x',repositoryPath:'/tmp/arbitrary'},{name:'x',instructions:'x'.repeat(3001)},{name:'x',slug:'Invalid Slug'}])assert.throws(() => createProjectSchema.parse(v));
});
test('manual memories have code-owned provenance, all sources/kinds/lengths validated and hashes idempotent', () => {
  const v=memoryInputSchema.parse({kind:'fact',content:'Market data',sourceType:'manual'});assert.equal(memoryHash(v),memoryHash({...v}));assert.notEqual(memoryHash(v),memoryHash({...v,content:'Other'}));
  for(const value of [{kind:'other',content:'x'},{kind:'fact',content:'x'.repeat(8001)},{kind:'fact',content:'x',sourceType:'manual'},{kind:'fact',content:'x',importance:6}])assert.throws(() => manualMemorySchema.parse(value));
  assert.throws(() => memoryInputSchema.parse({kind:'fact',content:'x'}));assert.throws(() => memoryInputSchema.parse({kind:'fact',content:'x',sourceType:'unknown'}));assert.throws(() => memoryInputSchema.parse({kind:'fact',content:'x',sourceType:'task'}));
});
test('hybrid ranking prefers high semantic relevance to recency and never returns cross-project candidates', () => {
  const relevant=memory({createdAt:'2020-01-01T00:00:00.000Z'}),unrelated=memory({importance:5}),other=memory({projectId:otherId});
  const ranked=rankMemories(projectId,[{...relevant,similarity:.95},{...unrelated,similarity:.25},{...other,similarity:1}],8,Date.parse(now));
  assert.equal(ranked[0]?.id,relevant.id);assert.equal(ranked.length,2);assert.ok(!ranked.some(m => m.projectId===otherId));
  assert.equal(rankMemories(projectId,[{...unrelated,similarity:0}]).length,0);
  assert.ok(memoryScore(.8,5,now,Date.parse(now))>memoryScore(.8,1,now,Date.parse(now)));
  assert.ok(memoryScore(.8,2,now,Date.parse(now))>memoryScore(.8,2,'2020-01-01T00:00:00.000Z',Date.parse(now)));
  assert.equal(rankMemories(projectId,Array.from({length:100},() => ({...memory(),similarity:.9}))).length,8);
  assert.throws(() => rankMemories(projectId,[],9));
});
test('context budgets, selected IDs, project fields and recent activity are explicit; vectors excluded', () => {
  const p=project();p.recentTasks=Array.from({length:8},() => ({id:randomUUID(),title:'Completed data change',status:'completed',updatedAt:now}));
  const candidates=Array.from({length:8},() => ({...memory({content:'x'.repeat(8000)}),similarity:1,score:.95}));
  const c=assembleProjectContext(p,'market data',{repositoryPath:'/registered/investi'},p.repositories[0]!,candidates,'ok',new Date(now));
  for(const text of ['Investi','Finance application','Build market data','Local privacy','server-only','Portfolio Lab','primary'])assert.ok(c.rendered.includes(text));
  assert.ok(c.rendered.length<=6400);assert.ok(JSON.stringify(c.input).length<=16000);assert.ok(c.submission.snapshot.memoryIds.length<8);assert.equal(c.submission.snapshot.recentTaskIds.length,5);
  for(const id of c.submission.snapshot.memoryIds)assert.ok(c.rendered.includes(id));
  for(const m of candidates.filter(m => !c.submission.snapshot.memoryIds.includes(m.id)))assert.ok(!c.rendered.includes(m.id));
  assert.ok(!JSON.stringify(c.input).includes('embedding'));assert.equal(submissionContextSchema.parse(c.submission).projectId,p.id);
  assert.throws(() => submissionContextSchema.parse({...c.submission,projectId:otherId}));
});
test('repository defaulting requires primary/sole binding; explicit out-of-project repository rejected', () => {
  const p=project();assert.equal(resolveProjectRepository(p)?.repositoryId,repoId);p.repositories=[];assert.equal(resolveProjectRepository(p),undefined);
  p.repositories=[{repositoryId:repoId,key:'a'.repeat(24),name:'a',role:null,isPrimary:false},{repositoryId:randomUUID(),key:'b'.repeat(24),name:'b',role:null,isPrimary:false}];assert.equal(resolveProjectRepository(p),undefined);
  assert.throws(() => resolveProjectRepository(p,randomUUID()));assert.equal(resolveProjectRepository(p,repoId)?.repositoryId,repoId);
});
test('project planning passes bounded data to existing Chief; missing/paused project asks human without inference',async () => {
  const p=project(),store={requireProject:async () => p,retrieve:async () => []} as unknown as ProjectStore;let calls=0;
  const plan=async () => {calls++;return {action:'no_action' as const,summary:'Complete',reason:'Nothing requested'};};
  const result=await planProjectGoal({projectId,userGoal:'Continue'}, {store,repository:async () => ({name:'Investi',repositoryPath:'/registered/investi'}),plan});assert.equal(calls,1);assert.equal(result.submission?.projectId,projectId);
  p.repositories=[];assert.equal((await planProjectGoal({projectId,userGoal:'Continue'}, {store,plan})).decision.action,'ask_human');assert.equal(calls,1);
  p.status='archived';assert.equal((await planProjectGoal({projectId,userGoal:'Continue'}, {store,plan})).decision.action,'ask_human');assert.equal(calls,1);
});
test('embedding failure degrades explicitly to static context and never changes task completion', async () => {
  const p=project(),store={requireProject:async () => p,retrieve:async () => {throw new EmbeddingError('offline','offline');}} as unknown as ProjectStore;
  const result=await planProjectGoal({projectId,userGoal:'Continue'}, {store,repository:async () => ({name:'Investi',repositoryPath:'/registered/investi'}),plan:async input => {assert.ok(input.project?.summary?.includes('Investi'));return {action:'no_action',summary:'Done',reason:'Complete'};}});
  assert.equal(result.submission?.snapshot.retrievalStatus,'unavailable');assert.deepEqual(result.submission?.snapshot.memoryIds,[]);
});
test('submission caller metadata passes independently of TaskSpec and repository-only delegation remains compatible',async () => {
  const fixture=createFixtureStore(),p=project(),built=assembleProjectContext(p,'Continue',{repositoryPath:'/registered/investi'},p.repositories[0]!,[]);
  const decision=await fixture.services.plan({userGoal:'Research market data',project:{repositoryPath:'/development/fixtures/investi'}});assert.equal(decision.action,'create_task');
  if(decision.action!=='create_task')return;
  let received: unknown;
  await submitDecision(decision,{projectContext:built.submission,createTask:async (_task,_queue,_recommendation,ctx) => {received=ctx;const result=await fixture.services.submit(decision);if(result.action!=='create_task')throw new Error('Unexpected fixture');return result.task;}});
  assert.deepEqual(received,built.submission);
  const result=await delegate({goal:'Continue',projectId},{...fixture.services,projectPlan:async () => ({decision,submission:built.submission}),submit:async (d,options) => {assert.deepEqual(options?.projectContext,built.submission);return fixture.services.submit(d);}});assert.equal(result.action,'create_task');
  assert.equal((await delegate({goal:'Clarify this'},fixture.services)).action,'ask_human');
});
test('outcome projection uses public evidence only, skips unfinished tasks and tolerates historical partial metadata', () => {
  const d=createFixtureStore().detail(fixtureTaskId)!;const projected=projectTaskOutcome(d)!;assert.equal(projected.sourceId,d.task.id);assert.equal(projected.sourceType,'task_outcome_sync');assert.ok(projected.content.includes('VERIFICATION:'));
  assert.equal(projectTaskOutcome({...d,task:{...d.task,status:'failed'}}),null);assert.equal(projectTaskOutcome({...d,task:{...d.task,status:'running'}}),null);
  const old=projectTaskOutcome({...d,runs:[],reviews:[]})!;assert.ok(old.content.includes('(not recorded)'));assert.ok(!old.content.includes('reasoning'));
});
test('project HTTP APIs enforce Host/Origin/UUID/schema boundaries before mutation',async () => {
  let calls=0;const store={createProject:async () => {calls++;return project();}} as unknown as ProjectStore;
  const request=(body:unknown,origin='http://127.0.0.1:3107') => new Request('http://127.0.0.1:3107/api/projects',{method:'POST',headers:{host:'127.0.0.1:3107',origin,'content-type':'application/json','x-request-id':randomUUID()},body:JSON.stringify(body)});
  assert.equal((await projectApi(request({name:'Valid'}),{}, {store})).status,200);assert.equal(calls,1);
  assert.equal((await projectApi(request({name:'x',path:'/arbitrary'}),{}, {store})).status,400);
  assert.equal((await projectApi(request({name:'x'},'https://evil.example'),{}, {store})).status,403);
  assert.equal((await projectApi(request({content:'x',kind:'fact',sourceType:'task'}),{id:projectId,operation:'memories'},{store})).status,400);
  assert.equal((await projectApi(request({query:'x',projectId:otherId}),{id:projectId,operation:'search'},{store})).status,400);
  assert.equal((await projectApi(request({name:'x'}),{id:'bad'},{store})).status,400);assert.equal(calls,1);
});
