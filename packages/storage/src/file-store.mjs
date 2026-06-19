import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
const initial=()=>({schemaVersion:'1.0.0',runs:[],events:[],memories:[],approvals:[],artifacts:[]});
export class FileStateStore {
  constructor(directory='.local'){this.directory=directory;this.file=path.join(directory,'state.json');this.#queue=Promise.resolve()}
  #queue;
  async init(){await mkdir(this.directory,{recursive:true,mode:0o700});try{await this.read()}catch{await this.#write(initial())}return this}
  async read(){return JSON.parse(await readFile(this.file,'utf8'))}
  async update(mutator){this.#queue=this.#queue.then(async()=>{const state=await this.read();const next=await mutator(structuredClone(state));await this.#write(next);return next});return this.#queue}
  async reset(){return this.update(()=>initial())}
  async #write(value){const tmp=`${this.file}.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,this.file)}
}
