import 'dotenv/config';
import { createEvaluationApp } from './app.js';
import { shutdownTracing } from '../instrumentation.js';

const {app,stop} = await createEvaluationApp();
const port = Number(process.env.EVALUATION_PORT??3003);
if (!Number.isInteger(port)||port<1||port>65535) throw new Error('EVALUATION_PORT must be a valid port.');
const server=app.listen(port,'127.0.0.1',()=>console.log(`Developer evaluations: http://127.0.0.1:${port} (local only; no calls or database workers)`));
server.on('error',error=>{console.error('Evaluation server could not start:',error.message);process.exitCode=1;void shutdownTracing();});
let closing=false;
async function close(){
  if(closing)return;closing=true;
  await stop();
  server.close(()=>{void shutdownTracing();});
}
process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
