const $ = id => document.getElementById(id);
const fieldNames = {visit_fee:'Visit fee',visit_date:'Visit date',visit_time:'Exact arrival time',enough_info:'Enough information'};
const fields = Object.keys(fieldNames);
let config,mode='manual',validatedPayload=null,currentRun=null,selectedCase=null,pollTimer=null,active=false;

function node(tag,text,className){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;}
function showError(message){$('error').textContent=message;$('error').hidden=false;}
function clearError(){$('error').hidden=true;}
function metricValue(metric){return metric?.percent===null||metric?.percent===undefined?'N/A':metric.percent+'%';}
function fraction(metric){return metric?`${metric.numerator} / ${metric.denominator}`:'—';}
function display(value,field){if(value===null)return 'Unknown';if(field==='visit_fee')return '₹'+Number(value).toLocaleString('en-IN');if(field==='enough_info')return value==='yes'?'Yes':'No';return String(value);}
async function api(url,body){
  const response=await fetch(url,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-Evaluation-Token':config.token}:{},body:body?JSON.stringify(body):undefined});
  const result=await response.json().catch(()=>({error:'The server returned an unreadable response.'}));
  if(!response.ok)throw Error(result.error??'Request failed.');return result;
}
function updateRunButton(){$('run').disabled=active||!validatedPayload||!$('api-consent').checked;$('resume').disabled=active||!currentRun?.canResume||!$('api-consent').checked;$('validate').disabled=active;$('api-consent').disabled=active;$('inputs').disabled=active;}
function invalidate(){validatedPayload=null;$('validation').hidden=true;updateRunButton();}
function switchMode(next){mode=next;const manual=next==='manual';$('manual-tab').setAttribute('aria-selected',String(manual));$('upload-tab').setAttribute('aria-selected',String(!manual));$('manual-panel').hidden=!manual;$('upload-panel').hidden=manual;invalidate();}
async function readFile(input){const file=input.files[0];if(!file)throw Error('Choose both a conversation file and an expected-label file.');if(file.size>8_000_000)throw Error('Each file must be smaller than 8 MB.');return file.text();}
function knownValue(id,unknown){if($(unknown).checked)return null;const value=$(id).value;if(value==='')throw Error('Enter a value or choose Unknown for each expected field.');return value;}
async function payload(){
  if(mode==='upload'){
    if($('saved-dataset').value)return {mode:'saved',datasetId:$('saved-dataset').value};
    return {mode:'upload',inputsText:await readFile($('conversation-file')),labelsText:await readFile($('label-file'))};
  }
  if(!$('transcript').value.trim())throw Error('Enter the conversation.');
  const fee=knownValue('expected-fee','fee-unknown');const id='manual-'+crypto.randomUUID();
  return {mode:'manual',input:{id,transcript:$('transcript').value,calledAt:new Date().toISOString(),timezone:'Asia/Kolkata'},
    label:{id,expected:{visit_fee:fee===null?null:Number(fee),visit_date:knownValue('expected-date','date-unknown'),visit_time:knownValue('expected-time','time-unknown'),enough_info:$('expected-enough').value}}};
}
async function validate(){clearError();$('validate').disabled=true;try{const data=await payload();const result=await api('/api/validate',data);validatedPayload=data;$('validation').textContent=`${result.total} matched case${result.total===1?'':'s'} · ${result.scorableCases} with scorable fields · ${result.excludedFields} disputed field${result.excludedFields===1?'':'s'} excluded. ${result.notice}`;$('validation').hidden=false;}catch(error){invalidate();showError(error.message);}finally{updateRunButton();}}
function scoreCard(title,metric,direction){const card=node('div',undefined,'score');card.append(node('span',title),node('strong',metricValue(metric)),node('span',`${fraction(metric)} · ${direction}`,'hint'));return card;}
function renderEmptyScores(){const empty={numerator:0,denominator:0,percent:null};$('scores').replaceChildren(scoreCard('Complete-case accuracy',empty,'higher is better'),scoreCard('Invented-value rate',empty,'lower is better'),scoreCard('Enough-info accuracy',empty,'higher is better'),scoreCard('False Yes rate',empty,'lower is better'));$('field-scores').replaceChildren(...fields.map(field=>{const row=node('tr');row.append(node('td',fieldNames[field]),node('td','N/A'),node('td','0 / 0'),node('td','0'));return row;}));}
function renderScores(run){
  const s=run.scores;$('overall-value').textContent=metricValue(s.overall);$('overall-count').textContent=`${s.overall.numerator} of ${s.overall.denominator} fields correct`;
  $('run-status').textContent=run.status;
  const state=run.progress;
  const waiting=state?.nextAttemptAt?Math.max(0,Math.ceil((Date.parse(state.nextAttemptAt)-Date.now())/1000)):0;
  const progress=state?` · ${state.caseId}: ${state.state==='rate_limited'?'rate-limited; retry in '+waiting+'s':state.state==='retrying_service'?'Gemini temporarily unavailable; retry in '+waiting+'s':state.state==='waiting'?'next request in '+waiting+'s':'calling model'}`:'';
  $('run-progress').textContent=`${s.successfulCases} successful · ${s.finishedCases} / ${s.totalCases} processed · ${s.modelErrors} current model error${s.modelErrors===1?'':'s'}${progress}`;
  $('progress').hidden=false;$('progress').max=s.totalCases;$('progress').value=s.finishedCases;
  $('scores').replaceChildren(scoreCard('Complete-case accuracy',s.completeCase,'higher is better'),scoreCard('Invented-value rate',s.inventedValues,'lower is better'),scoreCard('Enough-info accuracy',s.enoughInfo,'higher is better'),scoreCard('False Yes rate',s.falseYes,'lower is better'));
  $('field-scores').replaceChildren(...fields.map(field=>{const row=node('tr');row.append(node('td',fieldNames[field]),node('td',metricValue(s.perField[field]),'number'),node('td',fraction(s.perField[field]),'number'),node('td',String(s.perField[field].excluded),'number'));return row;}));
  const usage=s.usage;const tokens=['input','output','total'].filter(key=>usage[key]!==undefined).map(key=>`${key}: ${usage[key]}`).join(' · ')||'Token usage not reported';
  $('coverage').textContent=`Valid model responses: ${s.successfulCases}/${s.attemptedCases} · Request attempts: ${s.requestAttempts} · Fully excluded cases: ${s.fullyExcludedCases} · Model time: ${(s.durationMs/1000).toFixed(1)}s. ${tokens}. Usage includes reported tokens across retries; output includes reported reasoning. Cost is not estimated.`;
  $('download').href='/api/runs/'+encodeURIComponent(run.id)+'?download=true';$('download').hidden=false;
}
function caseScore(entry,result){const eligible=fields.filter(f=>!entry.excludedFields.includes(f));if(!result)return 'Pending';if(result.status==='excluded')return 'Needs review';if(result.status==='error')return 'Model error';const correct=eligible.filter(f=>entry.expected[f]===result.actual[f]).length;return `${correct}/${eligible.length} correct`;}
function renderCases(){
  const run=currentRun;if(!run)return;$('case-panel').hidden=false;const byId=new Map(run.results.map(r=>[r.id,r]));
  $('case-list').replaceChildren(...run.cases.map(entry=>{const button=node('button',undefined,'case-button');button.type='button';button.setAttribute('aria-pressed',String(entry.id===selectedCase));button.append(node('span',entry.id),node('span',caseScore(entry,byId.get(entry.id)),'tag'));button.addEventListener('click',()=>{selectedCase=entry.id;renderCases();});return button;}));
  const entry=run.cases.find(c=>c.id===selectedCase)??run.cases[0];if(!entry)return;
  const result=byId.get(entry.id);const content=$('case-detail');content.replaceChildren();content.append(node('h3',entry.id),node('p',`Call: ${new Date(entry.calledAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} · Asia/Kolkata`,'hint'));
  if(entry.reviewNote)content.append(node('p',entry.reviewNote,'case-warning'));
  if(result?.error)content.append(node('p',result.error,'case-warning'));
  if(result?.status==='completed')content.append(node('p',result.availabilityAsSaid?'Availability as stated: '+result.availabilityAsSaid:(run.configuration.outputVersion??1)<2?'This older prompt did not capture a separate arrival-period display field.':'No availability wording was captured.','hint'));
  const table=node('table');const head=node('thead');const header=node('tr');['Field','Expected','Model output','Check'].forEach(t=>header.append(node('th',t)));head.append(header);const body=node('tbody');
  fields.forEach(field=>{const row=node('tr');const excluded=entry.excludedFields.includes(field);let check='Pending',kind='';if(excluded)check='Excluded';else if(result?.status==='error'){check='Error';kind='bad';}else if(result?.actual){const same=entry.expected[field]===result.actual[field];check=same?'Match':entry.expected[field]===null?'Invented value':'Mismatch';kind=same?'good':'bad';}const cell=node('td');cell.append(node('span',check,'tag '+kind));row.append(node('td',fieldNames[field]),node('td',display(entry.expected[field],field)),node('td',result?.actual?display(result.actual[field],field):'—'),cell);body.append(row);});table.append(head,body);const wrap=node('div',undefined,'table-wrap');wrap.append(table);content.append(wrap);
  content.append(node('h3','Original transcript'),node('pre',entry.transcript,'transcript'));
  content.append(node('p','No summary was generated or scored. “Enough information” is not a confirmed booking.','hint'));
}
function renderRun(run){currentRun=run;active=run.status==='running';if(!run.cases.some(c=>c.id===selectedCase))selectedCase=run.cases[0]?.id??null;renderScores(run);renderCases();$('resume').hidden=!run.canResume;updateRunButton();const stopped=['interrupted','paused'].includes(run.status);$('notice').hidden=!stopped&&!run.promptChanged;const notes=[];if(stopped)notes.push(run.pauseReason??'This run stopped. Successful cases are saved. Resume will retry only failed or unfinished cases.');if(run.retryNotBefore)notes.push('Retry after: '+new Date(run.retryNotBefore).toLocaleString()+'.');if(run.resumeBlockedReason)notes.push(run.resumeBlockedReason);else if(run.promptChanged)notes.push('Resume uses the original saved prompt so scores are not mixed. Start a new evaluation to test the current prompt improvements.');if(stopped&&run.canResume)notes.push('Check the API-usage box to enable Resume.');$('notice').textContent=notes.join(' ');}
async function loadHistory(){const runs=await api('/api/runs');$('history').replaceChildren();if(!runs.length){const r=node('tr'),c=node('td','No saved runs yet.','muted');c.colSpan=6;r.append(c);$('history').append(r);return;}
  runs.forEach(run=>{const row=node('tr');const button=node('button','View','secondary');button.type='button';button.addEventListener('click',()=>openRun(run.id).catch(error=>showError(error.message)));const cell=node('td');cell.append(button);row.append(node('td',new Date(run.createdAt).toLocaleString()),node('td',run.status),node('td',`${run.scores.finishedCases}/${run.scores.totalCases}`),node('td',`${metricValue(run.scores.overall)} · ${fraction(run.scores.overall)}`),node('td',run.configuration.promptVersion),cell);$('history').append(row);});
}
function schedulePoll(){clearTimeout(pollTimer);if(active)pollTimer=setTimeout(async()=>{try{await openRun(currentRun.id);}catch(error){showError(error.message+' Saved results remain on disk. Reload when the server is available.');active=false;updateRunButton();}},1000);}
async function openRun(id){clearError();const run=await api('/api/runs/'+encodeURIComponent(id));renderRun(run);if(active)schedulePoll();else{clearTimeout(pollTimer);await loadHistory();}}
$('manual-tab').addEventListener('click',()=>switchMode('manual'));$('upload-tab').addEventListener('click',()=>switchMode('upload'));
$('inputs').addEventListener('input',invalidate);$('inputs').addEventListener('change',invalidate);
document.querySelectorAll('[data-unknown]').forEach(box=>box.addEventListener('change',()=>{$(box.dataset.unknown).disabled=box.checked;}));
$('saved-dataset').addEventListener('change',()=>{$('file-inputs').hidden=!!$('saved-dataset').value;});
$('api-consent').addEventListener('change',updateRunButton);$('validate').addEventListener('click',validate);
$('evaluation-form').addEventListener('submit',async event=>{event.preventDefault();clearError();if(!validatedPayload||!$('api-consent').checked)return;active=true;updateRunButton();try{const run=await api('/api/runs',{...validatedPayload,confirmApiUsage:true});renderRun(run);schedulePoll();await loadHistory();}catch(error){active=false;updateRunButton();showError(error.message);}});
$('resume').addEventListener('click',async()=>{if(!currentRun?.canResume||!$('api-consent').checked)return;clearError();active=true;updateRunButton();try{const run=await api('/api/runs/'+encodeURIComponent(currentRun.id)+'/resume',{confirmApiUsage:true});renderRun(run);schedulePoll();await loadHistory();}catch(error){active=false;updateRunButton();showError(error.message);}});
$('refresh-history').addEventListener('click',()=>loadHistory().catch(error=>showError(error.message)));
renderEmptyScores();
(async()=>{try{config=await api('/api/config');config.datasets.forEach(d=>{const option=node('option',d.name);option.value=d.id;$('saved-dataset').append(option);});$('model-info').textContent=`${config.configuration.model} · ${config.configuration.promptVersion}. Shares the backend extraction rules with an evaluation-only output schema. No new packages required.`;await loadHistory();if(config.activeRunId)await openRun(config.activeRunId);}catch(error){showError(error.message);}finally{updateRunButton();}})();
