'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../src/core');
const Library = require('../src/library');
const { MemoryVault } = require('../src/vault');
const { PasswordSync, mergeCredentials } = require('../src/password-sync');
function temporary(t) { const folder=fs.mkdtempSync(path.join(os.tmpdir(),'arco-sync-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));return folder; }
test('bookmarks converge in both directions with equal timestamps, local settings and newer local deletion',()=>{
  const a=core.initialLibrary(),b=structuredClone(a),at='2030-01-01T00:00:00.000Z';
  a.spaces[0].bookmarks.push({id:'bookmark',title:'A',url:'https://example.com/',parentID:null,updatedAt:at});
  b.spaces[0].bookmarks.push({...a.spaces[0].bookmarks[0],title:'B'});
  a.settings.extensions=[{path:'/local-only',id:'local'}];b.settings.extensions=[{path:'/remote-path',id:'remote'}];
  assert.deepEqual(core.mergeLibraries(a,b).spaces,core.mergeLibraries(b,a).spaces);
  assert.deepEqual(core.mergeLibraries(a,b).settings,a.settings);
  a.tombstones.bookmark='2030-01-03T00:00:00.000Z';b.tombstones.bookmark='2030-01-02T00:00:00.000Z';
  assert.equal(core.mergeLibraries(a,b).spaces[0].bookmarks.length,0);
  assert.equal(core.mergeLibraries(b,a).tombstones.bookmark,a.tombstones.bookmark);
});
test('file synchronization retains simultaneous edits in independent device snapshots and excludes local paths',async t=>{
  const root=temporary(t),folder=path.join(root,'cloud');fs.mkdirSync(folder);
  const a=new Library(path.join(root,'a'),()=>{}),b=new Library(path.join(root,'b'),()=>{});
  a.settings.syncFolder=b.settings.syncFolder=folder;
  a.settings.extensions=[{id:'local',path:'/never-upload-this'}];
  a.addBookmark({spaceID:'personal',title:'A',url:'https://a.test'});b.addBookmark({spaceID:'personal',title:'B',url:'https://b.test'});
  await a.syncNow();await b.syncNow();await a.syncNow();
  assert.equal(a.data.spaces[0].bookmarks.length,2);assert.deepEqual(a.data.spaces,b.data.spaces);
  const files=fs.readdirSync(path.join(folder,'Arco-Library'));
  assert.equal(files.length,2);
  for(const file of files)assert(!fs.readFileSync(path.join(folder,'Arco-Library',file),'utf8').includes('/never-upload-this'));
  const bookmark=a.data.spaces[0].bookmarks.find(x=>x.title==='A');a.deleteBookmark(bookmark.id);await a.syncNow();await b.syncNow();
  assert(!b.data.spaces[0].bookmarks.some(x=>x.id===bookmark.id));
  const file=path.join(folder,'Arco-Library',files[0]);fs.writeFileSync(file,'{broken');
  const before=fs.readFileSync(b.file,'utf8');await assert.rejects(()=>b.syncNow(),/损坏/);assert.equal(fs.readFileSync(b.file,'utf8'),before);assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});
test('untrusted bookmark trees reject duplicate IDs, unsafe URLs and cycles',()=>{
  const library=core.initialLibrary(),stamp='2030-01-01T00:00:00.000Z';
  library.spaces[0].folders=[{id:'one',name:'One',parentID:'two',updatedAt:stamp},{id:'two',name:'Two',parentID:'one',updatedAt:stamp}];
  assert.throws(()=>core.validateLibrary(library),/循环/);library.spaces[0].folders=[];
  library.spaces[0].bookmarks=[{id:'one',title:'Unsafe',url:'javascript:alert(1)',updatedAt:stamp}];assert.throws(()=>core.validateLibrary(library),/HTTP/);
});
test('corrupt-file backup failure stops instead of permitting later overwrite',t=>{
  const folder=temporary(t),file=path.join(folder,'data.json');fs.writeFileSync(file,'{broken');
  t.mock.method(fs,'copyFileSync',()=>{throw new Error('disk unavailable');});
  assert.throws(()=>core.loadJSON(file,{}),/停止写入/);assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});
test('independent password devices exchange authenticated ciphertext, retain whitespace and propagate deletion',async t=>{
  const folder=temporary(t),passphrase='arco-test-sync-passphrase';
  const a=new PasswordSync(()=>folder,'device-a'),b=new PasswordSync(()=>folder,'device-b');
  const vault=new MemoryVault(),saved=await vault.save({origin:'https://example.com',username:'alice',password:'  secret-password  '});
  a.unlock(passphrase);a.write(await vault.exportState());b.unlock(passphrase);
  assert.equal(b.readRemote().records[0].password,'  secret-password  ');
  const other={id:'other',origin:'https://other.test',username:'bob',password:'other-password',title:'',updatedAt:'2030-01-01T00:00:00.000Z'};
  b.write(mergeCredentials(b.readRemote(),{records:[other],tombstones:{}}));
  assert.equal(a.readRemote().records.length,2);
  const deleted={records:[],tombstones:{[saved.id]:'2099-01-01T00:00:00.000Z'}};
  a.write(mergeCredentials(a.readRemote(),deleted));assert(!b.readRemote().records.some(x=>x.id===saved.id));
  const bytes=fs.readdirSync(path.join(folder,'Arco-Password-Devices')).map(file=>fs.readFileSync(path.join(folder,'Arco-Password-Devices',file),'utf8')).join('');
  assert(!bytes.includes('secret-password'));assert(!bytes.includes(passphrase));
  const before=fs.readFileSync(a.file,'utf8');const wrong=new PasswordSync(()=>folder,'wrong');assert.throws(()=>wrong.unlock('definitely-wrong-password'),/口令/);assert.equal(fs.readFileSync(a.file,'utf8'),before);
  const file=path.join(folder,'Arco-Password-Devices','device-b.json'),envelope=JSON.parse(fs.readFileSync(file,'utf8'));
  const cipher=Buffer.from(envelope.ciphertext,'base64');cipher[0]^=1;envelope.ciphertext=cipher.toString('base64');fs.writeFileSync(file,JSON.stringify(envelope));
  assert.throws(()=>a.readRemote(),/篡改/);a.lock();assert.equal(a.unlocked,false);assert.throws(()=>a.write(deleted),/解锁/);
});
test('HTML export/import preserves shared nested paths',()=>{
  const entries=[{title:'One',url:'https://a.test/',folders:['Work','Docs']},{title:'Two',url:'https://b.test/',folders:['Work','Docs']},{title:'Use <tag> literally',url:'https://root.test/',folders:[]},{title:'Sib',url:'https://sib.test/',folders:['<Docs>']}];
  const html=core.netscape(entries),result=core.parseNetscape(html);
  assert.deepEqual(result.map(x=>x.folders),entries.map(x=>x.folders));
  assert.deepEqual(result.map(x=>x.title),entries.map(x=>x.title));
  assert.deepEqual(result.map(x=>x.url),entries.map(x=>x.url));
  assert.equal(html.match(/<H3>Work<\/H3>/g).length,1);assert.equal(html.match(/<H3>Docs<\/H3>/g).length,1);
  assert.equal(html.match(/<H3>&lt;Docs&gt;<\/H3>/g).length,1);
});

test('Arc Sync containers import pins, favorites, folders and space color',()=>{
  const spaces=core.parseArcSidebar({sidebarSyncState:{container:{value:{orderedSpaceIDs:['space'],topAppsContainerIDs:['top']}},spaceModels:[{value:{id:'space',title:'Work',containerIDs:[{pinned:{}},'pins'],customInfo:{windowTheme:{primaryColorPalette:{midTone:{red:.5,green:.6,blue:.7}}}}}}],items:[{value:{id:'pins',childrenIds:['folder']}},{value:{id:'folder',title:'Docs',childrenIds:['page']}},{value:{id:'page',title:'Example',data:{tab:{savedURL:'https://example.com'}}}},{value:{id:'top',childrenIds:['favorite']}},{value:{id:'favorite',data:{tab:{savedURL:'https://favorite.test'}}}}]}});
  assert.equal(spaces[0].name,'Work');assert.deepEqual(spaces[0].bookmarks[0].folders,['Docs']);assert.equal(spaces[0].customColor,'#8099b3');assert.equal(spaces.favorites.length,1);
});
test('import reuses an existing folder path',t=>{
  const root=temporary(t),library=new Library(root,()=>{});
  library.importBookmarks([{title:'One',url:'https://one.test/',folders:['Docs']}],'personal');
  library.importBookmarks([{title:'Two',url:'https://two.test/',folders:['Docs']}],'personal');
  assert.equal(library.space('personal').folders.length,1);
});
test('deletion and append keep deterministic ids in array order across sync',t=>{
  const root=temporary(t),library=new Library(root,()=>{});
  library.addBookmark({spaceID:'personal',title:'Kept',url:'https://kept.test/'});
  library.addBookmark({spaceID:'personal',title:'Removed',url:'https://removed.test/'});
  library.space('personal').bookmarks.find(x=>x.title==='Kept').id='m-kept';
  library.space('personal').bookmarks.find(x=>x.title==='Removed').id='m-removed';
  library.save();library.deleteBookmark('m-removed');
  library.addBookmark({spaceID:'personal',title:'Added',url:'https://added.test/'});
  library.space('personal').bookmarks.find(x=>x.title==='Added').id='a-added';library.save();
  const ids=library.data.spaces[0].bookmarks.map(x=>x.id);
  assert.deepEqual(ids,['m-kept','a-added']);
  assert.deepEqual(core.mergeLibraries(library.data,structuredClone(library.data)).spaces[0].bookmarks.map(x=>x.id),ids);
  const other=library.addSpace('第二');
  const previous=library.space('personal').bookmarks.find(x=>x.id==='a-added').updatedAt;
  library.moveBookmark({id:'m-kept',spaceID:other.id});
  assert.equal(library.space('personal').bookmarks[0].id,'a-added');
  assert.equal(library.space('personal').bookmarks[0].order,0);
  assert.notEqual(library.space('personal').bookmarks[0].updatedAt,previous);
  assert.deepEqual(library.space(other.id).bookmarks.map(x=>x.order),[0]);
});
test('rejected library writes preserve memory, file bytes and reopen',t=>{
  const root=temporary(t),library=new Library(root,()=>{});
  library.addFolder({spaceID:'personal',name:'Docs'});
  const before=fs.readFileSync(library.file,'utf8'),memory=structuredClone(library.data);
  assert.throws(()=>library.addSpace('   '),/名称不能为空/);
  assert.throws(()=>library.updateSpace({id:'personal',name:'  '}),/名称不能为空/);
  assert.throws(()=>library.addFolder({spaceID:'personal',name:' \t '}),/名称不能为空/);
  assert.throws(()=>library.updateFolder({id:library.space('personal').folders[0].id,name:'\n'}),/名称不能为空/);
  assert.throws(()=>library.importBookmarks([{title:'Deep',url:'https://deep.test/',folders:Array.from({length:66},(_,i)=>'n'+i)}],'personal'),/64/);
  assert.deepEqual(library.data,memory);assert.equal(fs.readFileSync(library.file,'utf8'),before);
  const heavy=core.initialLibrary(),stamp=heavy.updatedAt;
  heavy.spaces[0].folders=Array.from({length:4998},(_,i)=>({id:'f'+i,name:'N'+i,parentID:null,open:true,updatedAt:stamp}));
  core.validateLibrary(heavy);core.atomicWrite(path.join(root,'Library.json'),heavy);
  const limited=new Library(root,()=>{}),bytes=fs.readFileSync(limited.file);
  assert.throws(()=>limited.importBookmarks([{title:'More',url:'https://more.test/',folders:['A','B','C']}],'personal'),/超出限制/);
  assert.equal(limited.space('personal').folders.length,4998);assert.equal(fs.readFileSync(limited.file,'utf8'),bytes.toString());
  assert.equal(new Library(root,()=>{}).space('personal').folders.length,4998);
  assert.equal(new Library(root,()=>{}).space('personal').name,'个人');
});

test('injected library write failure preserves memory, disk and later saves',t=>{
  const root=temporary(t),library=new Library(root,()=>{}),before=fs.readFileSync(library.file,'utf8'),memory=structuredClone(library.data);
  t.mock.method(core,'atomicWrite',()=>{throw new Error('disk unavailable');});
  assert.throws(()=>library.addBookmark({spaceID:'personal',title:'Failed write',url:'https://failed.test/'}),/disk unavailable/);
  assert.deepEqual(library.data,memory);assert.equal(fs.readFileSync(library.file,'utf8'),before);
  t.mock.restoreAll();
  library.addBookmark({spaceID:'personal',title:'Later write',url:'https://later.test/'});
  const reopened=new Library(root,()=>{});
  assert.equal(reopened.space('personal').bookmarks.some(x=>x.title==='Failed write'),false);
  assert.equal(reopened.space('personal').bookmarks.some(x=>x.title==='Later write'),true);
});

test('oversized fresh imports reject atomically instead of dropping records',t=>{
  const root=temporary(t),library=new Library(root,()=>{}),before=fs.readFileSync(library.file,'utf8'),memory=structuredClone(library.data);
  const items=Array.from({length:20001},(_,i)=>({title:'B'+i,url:'https://example.test/'+i,folders:[]}));
  assert.throws(()=>library.importBookmarks(items,'personal'),/20000/);
  assert.deepEqual(library.data,memory);assert.equal(fs.readFileSync(library.file,'utf8'),before);
  const tooMany=Array.from({length:201},(_,i)=>({name:'Space '+i,color:'sky',bookmarks:[]}));
  assert.throws(()=>library.importSpaces(tooMany),/200/);
  assert.deepEqual(library.data,memory);assert.equal(fs.readFileSync(library.file,'utf8'),before);
  const valid=tooMany.slice(0,101);assert.equal(library.importSpaces(valid),101);
  assert.equal(library.data.spaces.length,102);assert.equal(new Library(root,()=>{}).data.spaces.length,102);
});
test('space deletion and append preserve order across merge and subsequent import',t=>{
  const root=temporary(t),library=new Library(root,()=>{});
  library.addSpace('Middle');library.addSpace('Last');
  library.data.spaces[0].id='first';library.data.spaces[1].id='middle';library.data.spaces[2].id='z-last';
  library.data=core.mergeLibraries(library.data,structuredClone(library.data));library.settings=library.data.settings;library.save();
  library.removeSpace('middle');library.addSpace('Added');library.data.spaces.at(-1).id='a-added';library.save();
  assert.deepEqual(library.data.spaces.map(s=>s.id),['first','z-last','a-added']);
  assert.deepEqual(library.data.spaces.map(s=>s.order),[0,1,2]);
  assert.deepEqual(core.mergeLibraries(library.data,structuredClone(library.data)).spaces.map(s=>s.id),['first','z-last','a-added']);
  library.importSpaces([{name:'Imported',color:'mint',bookmarks:[]}]);assert.deepEqual(library.data.spaces.map(s=>s.order),[0,1,2,3]);
});

test('permanent shortcuts retain real favicons, deduplicate and persist across reload',t=>{
  const directory=temporary(t),library=new Library(directory,()=>{});
  const first=library.addFavorite({title:'Example',url:'https://example.test',favicon:'https://example.test/icon.svg'});
  const repeated=library.addFavorite({title:'Duplicate',url:'https://example.test/'});assert.equal(first.id,repeated.id);assert.equal(library.data.favorites.length,1);
  assert.throws(()=>library.addFavorite({title:'Unsafe',url:'javascript:alert(1)'}),/HTTP/);
  const reopened=new Library(directory,()=>{});assert.equal(reopened.data.favorites[0].favicon,'https://example.test/icon.svg');assert.equal(reopened.data.favorites[0].title,'Example');
});
