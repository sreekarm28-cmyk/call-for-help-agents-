const el=id=>document.getElementById(id);
const make=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
let token,mode='manual',validated=null,current=null,active=false,poll;
const percent=value=>value?.percent==null?'N/A':value.percent+'%';
const pin=value=>value?`${value.latitude.toFixed(6)}, ${value.longitude.toFixed(6)}`:'—';
function error(message){el('location-error').textContent=message;el('location-error').hidden=!message;}
async function api(url,body){const response=await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-Evaluation-Token':token}:{},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw Error(result.error??'Location evaluation request failed.');return result;}
function buttons(){el('location-run').disabled=active||!validated||!token||!el('location-consent').checked;el('location-validate').disabled=active||!token;el('location-inputs').disabled=active;el('location-consent').disabled=active;}
function invalidate(){validated=null;el('location-validation').hidden=true;buttons();}
function switchMode(next){mode=next;for(const name of ['manual','batch']){el('location-'+name).hidden=name!==next;el('location-'+name+'-tab').setAttribute('aria-selected',String(name===next));}invalidate();}
function cases(){
  if(mode==='batch'){const text=el('location-json').value.trim();if(!text)throw Error('Load or upload a location dataset.');try{const value=JSON.parse(text);return Array.isArray(value)?value:value.cases??[value];}catch{try{return text.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));}catch{throw Error('Use a JSON array or JSONL records.');}}}
  const address=el('location-address').value.trim(),expectedResolvable=el('location-valid').checked;
  if(!address)throw Error('Enter an address.');
  const latitude=el('location-latitude').value,longitude=el('location-longitude').value;
  if(expectedResolvable&&(!latitude.trim()||!longitude.trim()))throw Error('Enter the reference latitude and longitude.');
  return [{id:'manual-location',address,expectedResolvable,expectedLocation:expectedResolvable?{latitude:Number(latitude),longitude:Number(longitude)}:null}];
}
function scores(run){const s=run?.scores;el('location-scores').replaceChildren();
  for(const [title,key]of [['Within 500 m','withinTarget'],['Lookup success','lookupSuccess'],['False acceptance','falseAcceptance'],['Correct rejection','correctRejection']]){const value=s?.[key],card=make('div',undefined,'score');card.append(make('span',title),make('strong',percent(value)),make('span',`${value?.numerator??0} / ${value?.denominator??0}`,'hint'));el('location-scores').append(card);}
  for(const [title,value]of [['Median distance error',s?.medianDistanceMetres==null?'N/A':s.medianDistanceMetres.toFixed(1)+' m'],['Average response time',s?.meanResponseMs==null?'N/A':(s.meanResponseMs/1000).toFixed(2)+' s']]){const card=make('div',undefined,'score');card.append(make('span',title),make('strong',value));el('location-scores').append(card);}}
function render(run){current=run;active=run.status==='running';scores(run);buttons();el('location-status').textContent=run.status;el('location-progress').textContent=`${run.results.length} / ${run.cases.length} processed · ${run.scores.errors} API/technical errors${active?' · Looking up addresses…':''}`;
  const byId=new Map(run.results.map(result=>[result.id,result]));el('location-results').replaceChildren();
  for(const entry of run.cases){const result=byId.get(entry.id),row=make('tr'),name=make('td');name.append(make('strong',entry.id),make('p',entry.address,'hint'));let verdict='Pending';if(result){verdict=result.status==='error'?'API error':entry.expectedResolvable?result.status==='unresolved'?'Lookup failed':result.distanceMetres<=500?'Within target':'Outside target':result.status==='unresolved'?'Correct rejection':'Wrong acceptance';}const status=make('td');status.append(make('span',verdict,'tag '+(['Within target','Correct rejection'].includes(verdict)?'good':result?'bad':'')));if(result?.error)status.append(make('p',result.error,'hint'));row.append(name,make('td',entry.expectedResolvable?pin(entry.expectedLocation):'Should reject'),make('td',pin(result?.actual)),make('td',result?.distanceMetres==null?'—':result.distanceMetres.toFixed(1)+' m'),make('td',result?(result.durationMs/1000).toFixed(2)+' s':'—'),status);el('location-results').append(row);}
  el('location-download').href='/api/location/runs/'+encodeURIComponent(run.id)+'?download=true';el('location-download').hidden=false;
  clearTimeout(poll);if(active)poll=setTimeout(()=>openRun(run.id).catch(e=>{error(e.message+' Completed results remain saved.');active=false;buttons();}),1000);
}
async function history(){const runs=await api('/api/location/runs');el('location-history').replaceChildren();if(!runs.length){const row=make('tr'),cell=make('td','No saved location runs yet.');cell.colSpan=5;row.append(cell);el('location-history').append(row);}for(const run of runs){const row=make('tr'),cell=make('td'),button=make('button','View','secondary');button.type='button';button.addEventListener('click',()=>openRun(run.id).catch(e=>error(e.message)));cell.append(button);row.append(make('td',new Date(run.createdAt).toLocaleString()),make('td',run.status),make('td',`${run.results.length}/${run.cases.length}`),make('td',percent(run.scores.withinTarget)),cell);el('location-history').append(row);}return runs;}
async function openRun(id){render(await api('/api/location/runs/'+encodeURIComponent(id)));if(!active)await history();}
el('location-manual-tab').addEventListener('click',()=>switchMode('manual'));el('location-batch-tab').addEventListener('click',()=>switchMode('batch'));
el('location-inputs').addEventListener('input',invalidate);el('location-inputs').addEventListener('change',invalidate);
el('location-valid').addEventListener('change',()=>{el('location-reference').hidden=!el('location-valid').checked;});
el('location-consent').addEventListener('change',buttons);
el('location-collected').addEventListener('click',async()=>{try{error('');el('location-json').value=JSON.stringify(await api('/api/location/dataset'),null,2);invalidate();}catch(e){error(e.message);}});
el('location-file').addEventListener('change',async()=>{try{const file=el('location-file').files[0];if(!file)return;if(file.size>2000000)throw Error('Choose a dataset smaller than 2 MB.');el('location-json').value=(await file.text()).replace(/^\uFEFF/,'');invalidate();}catch(e){error(e.message);}});
el('location-validate').addEventListener('click',async()=>{error('');try{const entries=cases();const result=await api('/api/location/validate',{cases:entries});validated=entries;el('location-validation').textContent=`${result.total} valid inputs. No Google requests have been made.`;el('location-validation').hidden=false;}catch(e){invalidate();error(e.message);}buttons();});
el('location-form').addEventListener('submit',async event=>{event.preventDefault();if(active||!validated||!el('location-consent').checked)return;active=true;buttons();error('');try{render(await api('/api/location/runs',{cases:validated,confirmApiUsage:true}));await history();}catch(e){active=false;buttons();error(e.message);}});
el('location-refresh').addEventListener('click',()=>history().catch(e=>error(e.message)));
scores();buttons();(async()=>{try{token=(await api('/api/config')).token;const runs=await history();const running=runs.find(run=>run.status==='running');if(running)render(running);}catch(e){error(e.message);}finally{buttons();}})();
