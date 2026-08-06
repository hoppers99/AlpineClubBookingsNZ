import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const args=new Map();for(let i=2;i<process.argv.length;i+=2)args.set(process.argv[i],process.argv[i+1]);
const required=(name)=>args.get(`--${name}`)??(()=>{throw new Error(`--${name} is required`);})();
const runRoot=resolve(required("run-root")),raw=resolve(required("raw")),out=resolve(required("out")),side=required("side"),imageId=required("image-id");
if(!new Set(["current","baseline"]).has(side))throw new Error("invalid side");
if(!/^sha256:[a-f0-9]{64}$/.test(imageId))throw new Error("invalid image id");
const rel=(path)=>{const value=relative(runRoot,path);if(!value||value===".."||value.startsWith(`..${sep}`))throw new Error("route evidence escapes run root");return value.split(sep).join("/");};
const parseHeaders=(path)=>{
  const blocks=readFileSync(path,"utf8").split(/\r?\n\r?\n/).filter((block)=>/^HTTP\//m.test(block));
  if(blocks.length!==1)throw new Error(`${path} must contain exactly one HTTP block`);
  const lines=blocks[0].split(/\r?\n/);const status=Number(/^HTTP\/\S+\s+(\d{3})/.exec(lines[0])?.[1]);
  const values=new Map();for(const line of lines.slice(1)){const match=/^([^:]+):\s*(.*)$/.exec(line);if(!match)continue;const key=match[1].toLowerCase();values.set(key,[...(values.get(key)??[]),match[2].trim()]);}
  const one=(name)=>{const found=values.get(name)??[];if(found.length>1)throw new Error(`${path} has duplicate ${name}`);return found[0]??null;};
  return{status,nextCache:one("x-nextjs-cache"),etag:one("etag")};
};
const sha=(path)=>createHash("sha256").update(readFileSync(path)).digest("hex");
const sample=(phase,prefix)=>{const headers=resolve(raw,`${prefix}.headers`),body=resolve(raw,`${prefix}.body.html`);return{phase,headers_path:rel(headers),body_path:rel(body),parsed:parseHeaders(headers),body_sha256:sha(body)};};
const routes={};
const about=[sample(side==="current"?"miss":"first","binding-about-1"),sample(side==="current"?"hit":"second","binding-about-2")];
if(about.some((entry)=>entry.parsed.status!==200))throw new Error("/about binding sample did not return 200");
if(side==="current"){
  if(about[0].parsed.nextCache!=="MISS"||about[1].parsed.nextCache!=="HIT"||!about[0].parsed.etag||about[0].parsed.etag!==about[1].parsed.etag||about[0].body_sha256!==about[1].body_sha256)throw new Error("current /about MISS/HIT binding is unstable");
}else if(about.some((entry)=>entry.parsed.nextCache!==null))throw new Error("baseline /about unexpectedly has x-nextjs-cache");
routes["/about"]={samples:about.map(({phase,headers_path,body_path})=>({phase,headers_path,body_path})),derived:side==="current"?{status:200,next_cache:"HIT",etag:about[1].parsed.etag,body_sha256:about[1].body_sha256}:{status:200,next_cache:"ABSENT",etag:null,body_sha256:null}};
for(const [route,prefix] of [["/","binding-root"],["/join","binding-join"],["/contact","binding-contact"]]){
  const found=sample("request",prefix);if(found.parsed.status!==200||found.parsed.nextCache!==null)throw new Error(`${route} is not a 200 dynamic control`);
  routes[route]={samples:[{phase:found.phase,headers_path:found.headers_path,body_path:found.body_path}],derived:{status:200,next_cache:"ABSENT",etag:null,body_sha256:null}};
}
writeFileSync(out,JSON.stringify({schema_version:1,side,image_id:imageId,routes},null,2)+"\n",{flag:"wx"});
