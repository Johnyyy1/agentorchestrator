import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { eq } from 'drizzle-orm';
import { pool, db } from '../db/index.js';
import { tasks, repositories } from '../db/schema.js';
import { ProjectStore } from './store.js';
import { fakeEmbeddings, fakeModel, fakeVector } from '../memory/test-helpers.js';
import { EmbeddingError } from '../memory/embedding.js';
import { buildProjectContext } from './context.js';
import { createTask } from '../tasks/create-task.js';
import { syncProjectTaskMemories } from '../memory/outcome-sync.js';
import { registerRepository } from '../control-plane/repositories.js';
import { getTaskDetail, getTasks, parseTaskQuery } from '../control-plane/queries.js';
import { boss } from '../queue/boss.js';
import { projectApi } from '../control-plane/project-api.js';
const store=new ProjectStore(pool,fakeEmbeddings), ownedProjects: string[]=[], taskIds: string[]=[], repositoryIds: string[]=[];
const marker=`memory-test-${randomUUID()}`, queueName=`jonas-os.memory-test.${randomUUID()}`;
const directory=await mkdtemp(join(tmpdir(),'project-memory-db-'));const path=await realpath(directory);
async function insertProject(name: string, bindings: unknown[]=[]) { const p=await store.createProject({name,slug:`${marker}-${name.toLowerCase()}`,repositories:bindings});ownedProjects.push(p.id);return p; }
async function fingerprint() { const result=await pool.query(`select 'tasks' as entity,md5(coalesce(string_agg((to_jsonb(t)-'project_id'-'project_context')::text,'' order by id),'')) as hash from tasks t where not(id=any($1::uuid[])) union all
  select 'runs',md5(coalesce(string_agg(to_jsonb(r)::text,'' order by id),'')) from runs r where not(task_id=any($1::uuid[])) union all
  select 'repositories',md5(coalesce(string_agg(to_jsonb(r)::text,'' order by id),'')) from repositories r where not(id=any($2::uuid[]))`,[taskIds,repositoryIds]);return result.rows; }
const before=await fingerprint();
try {
  await execa('git',['init','-b','main',path]); const r=await registerRepository({path});repositoryIds.push(r.id);
  const secondPath=join(path,'other');await execa('git',['init','-b','main',secondPath]);const r2=await registerRepository({path:secondPath});repositoryIds.push(r2.id);
  const p=await insertProject('Investi',[{repositoryId:r.id,isPrimary:true,role:'app'},{repositoryId:r2.id,isPrimary:false}]),other=await insertProject('Other',[{repositoryId:r.id,isPrimary:true}]);
  assert.equal(p.repositories.length,2);assert.equal(p.repositories[0]?.isPrimary,true);
  await assert.rejects(store.createProject({name:'Duplicate',slug:p.slug}),/slug/);
  await assert.rejects(store.updateProject(p.id,{repositories:[{repositoryId:r.id,isPrimary:true},{repositoryId:r2.id,isPrimary:true}]}));
  await assert.rejects(store.updateProject(p.id,{repositories:[{repositoryId:randomUUID()}]}),/registered/);
  assert.equal((await store.getProject(p.id))?.repositories.length,2); // failed transaction preserved bindings
  await assert.rejects(pool.query(`update project_repositories set is_primary=true where project_id=$1 and repository_id=$2`,[p.id,r2.id]),(e:unknown) => !!e && typeof e==='object' && 'code' in e && e.code==='23505');
  await assert.rejects(db.delete(repositories).where(eq(repositories.id,r.id))); // bound registry identity restricted
  const updated=await store.updateProject(p.id,{goals:'Build market data',constraints:'No cloud',instructions:'Use MarketDataService',currentMilestone:'Portfolio Lab'});assert.equal(updated.goals,'Build market data');
  const knowledge=await store.createManualMemory(p.id,{kind:'architecture',title:'Market data',content:'MarketDataService is server-only',importance:4});assert.equal(knowledge.created,true);assert.equal(knowledge.indexing.indexed,true);
  const duplicate=await store.createManualMemory(p.id,{kind:'architecture',title:'Market data',content:'MarketDataService is server-only',importance:4});assert.equal(duplicate.created,false);assert.equal(duplicate.memory.id,knowledge.memory.id);
  const dark=await store.createManualMemory(p.id,{kind:'fact',content:'User prefers dark mode'});
  await store.createManualMemory(other.id,{kind:'decision',content:'Market data in another project'});
  const found=await store.retrieve(p.id,{query:'market data architecture'});assert.equal(found[0]?.id,knowledge.memory.id);assert.ok(found.every(m => m.projectId===p.id));assert.ok(!found.some(m => m.id===dark.memory.id));assert.ok(!JSON.stringify(found).includes('"vector"'));
  const vector=await pool.query(`select vector_dims(embedding) as dimensions,embedding <=> $2::vector as distance from project_memories where id=$1`,[knowledge.memory.id,JSON.stringify(fakeVector('market data'))]);assert.equal(vector.rows[0].dimensions,1024);assert.equal(vector.rows[0].distance,0);
  const broken=new ProjectStore(pool,{ready:fakeEmbeddings.ready,embed:async () => {throw new EmbeddingError('offline','local unavailable');}});
  const unindexed=await broken.createManualMemory(p.id,{kind:'issue',content:'Indexing unavailable test'});assert.equal(unindexed.indexing.indexed,false);assert.equal(unindexed.indexing.error,'offline');assert.ok((await store.listMemories(p.id)).items.some(m => m.id===unindexed.memory.id));assert.equal((await store.indexPending(p.id)).embeddingFailures,0);
  const built=await buildProjectContext({projectId:p.id,userGoal:'market data architecture'},{store});assert.ok('input' in built);if(!('input' in built))throw new Error('Missing context');
  const spec={title:marker,objective:'Explicit fixture; never execute',category:'utility' as const,difficulty:1 as const,risk:'low' as const,context:[],acceptanceCriteria:['Never execute this fixture.'],maxAttempts:1};
  const created=await createTask(spec,queueName,undefined,built.submission);taskIds.push(created.id);assert.equal(created.projectId,p.id);assert.deepEqual(created.projectContext,built.submission.snapshot);assert.equal(created.status,'queued');
  const detail=await getTaskDetail(created.id);assert.equal(detail?.task.projectId,p.id);assert.equal(detail?.task.projectContext?.memoryIds[0],knowledge.memory.id);
  assert.equal((await getTasks(parseTaskQuery({projectId:p.id}))).total,1);
  await assert.rejects(pool.query(`update tasks set project_context='{}'::jsonb where id=$1`,[created.id]),/immutable/);
  const staleContext={...built.submission,snapshot:{...built.submission.snapshot,projectUpdatedAt:'2000-01-01T00:00:00.000Z'}};await assert.rejects(createTask(spec,queueName,undefined,staleContext),/changed/);
  const crossContext={...built.submission,snapshot:{...built.submission.snapshot,memoryIds:[(await store.listMemories(other.id)).items[0]!.id]}};await assert.rejects(createTask(spec,queueName,undefined,crossContext),/context changed/);
  await pool.query(`update tasks set status='completed' where id=$1`,[created.id]); // fixture only; no executor or LLM
  const historical=await db.insert(tasks).values({...spec,title:`${marker} historical`,status:'completed',queueName,projectId:p.id,projectContext:built.submission.snapshot}).returning();taskIds.push(historical[0]!.id);
  const failed=await db.insert(tasks).values({...spec,title:`${marker} failed`,status:'failed',queueName,projectId:p.id,projectContext:built.submission.snapshot}).returning();taskIds.push(failed[0]!.id);
  const nonProject=await createTask({...spec,title:`${marker} legacy`},queueName);taskIds.push(nonProject.id);assert.equal(nonProject.projectId,null);assert.equal((await getTaskDetail(nonProject.id))?.task.projectContext,null);
  const first=await syncProjectTaskMemories(p.id,{store});assert.equal(first.scanned,2);assert.equal(first.created,2);assert.equal(first.embeddingFailures,0);
  const second=await syncProjectTaskMemories(p.id,{store});assert.equal(second.created,0);assert.equal(second.alreadyExisted,2);
  const outcome=(await store.listMemories(p.id)).items.find(m => m.sourceId===created.id)!;assert.equal(outcome.sourceType,'task_outcome_sync');assert.ok(outcome.content.includes('(not recorded)'));await assert.rejects(store.archiveManualMemory(p.id,outcome.id),/Only/);
  await store.archiveManualMemory(p.id,knowledge.memory.id);assert.ok(!(await store.retrieve(p.id,{query:'market data'})).some(m => m.id===knowledge.memory.id));assert.equal((await getTaskDetail(created.id))?.task.projectContext?.memoryIds[0],knowledge.memory.id);
  assert.equal((await store.updateProject(p.id,{status:'archived'})).status,'archived');assert.equal((await getTaskDetail(created.id))?.task.projectId,p.id);
  await assert.rejects(pool.query('delete from projects where id=$1',[p.id]));
  const headers={host:'127.0.0.1:3107',origin:'http://127.0.0.1:3107','content-type':'application/json','x-request-id':randomUUID()};
  const response=await projectApi(new Request('http://127.0.0.1:3107/api/projects',{method:'POST',headers,body:JSON.stringify({name:'API fixture',slug:`${marker}-api`,repositories:[{repositoryId:r.id,isPrimary:true}]})}),{}, {store});assert.equal(response.status,200);const api=await response.json();ownedProjects.push(api.id);
  const post=(operation:string,body:unknown) => projectApi(new Request(`http://127.0.0.1:3107/api/projects/${api.id}/${operation}`,{method:'POST',headers:{...headers,'x-request-id':randomUUID()},body:JSON.stringify(body)}),{id:api.id,operation},{store});
  assert.equal((await post('memories',{kind:'fact',content:'Market data API fixture'})).status,200);
  const search=await post('search',{query:'market data'});assert.equal(search.status,200);assert.equal((await search.json())[0]?.projectId,api.id);
  assert.equal((await post('memories',{kind:'fact',content:'x',sourceType:'import'})).status,400);
  console.log(JSON.stringify({success:true,vector:vector.rows[0],sync:first,idempotentSync:second,legacyTasks:true,immutableSnapshot:true,projectIsolation:true,historyPreserved:true}));
} finally {
  await boss.start(); await boss.deleteQueue(queueName);await boss.stop({graceful:true});
  for(const id of taskIds)await db.delete(tasks).where(eq(tasks.id,id));
  for(const id of ownedProjects)await pool.query('delete from projects where id=$1',[id]);
  for(const id of repositoryIds)await db.delete(repositories).where(eq(repositories.id,id));
  await rm(directory,{recursive:true,force:true});assert.deepEqual(await fingerprint(),before);await pool.end();
}
