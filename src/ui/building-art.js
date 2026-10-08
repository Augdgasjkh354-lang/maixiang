import { MODS } from "../mods/registry.js";
import { modArt } from "../mods/api.js";
/**
 * 麦乡 · 江南建筑绘制库 v1.0 / 无外部依赖 / SVG
 * 单位：建筑锚点为地块中心，常规占地约 140×120。
 * HTML 已内嵌本库，无需与本文件放在一起。此文件用于后续开发。
 *
 * import { renderBuildingArt, BUILDING_ART_CATALOG } from './maixiang-buildings.js';
 * svg.innerHTML = renderBuildingArt('mill', {level: 1, status:'complete'});
 * 选项：level 1..10；scale 0.1..4；status 'empty'|'construction'|'complete'；progress 0..1。
 * empty 返回空字符串；construction 仅显示地基与脚手架；complete 显示建筑。
 * 本库只负责外观，不结算产出、就业、住房或银行业务。
 * 新增建筑：在目录加入类型，在 renderComplete 中添加对应分支。
 */
export const BUILDING_ART_CATALOG = Object.freeze({
  mill:{name:'磨坊',connected:true}, public_housing:{name:'公租房群',connected:true},
  bakery:{name:'面包房',connected:true}, lumberyard:{name:'伐木场',connected:true},
  stock_exchange:{name:'交易所',connected:true}, bank:{name:'银行',connected:true},
  saltworks:{name:'盐场',connected:true}, wholesale_market:{name:'批发市场',connected:true},
  winery:{name:'酒坊',connected:true}, cotton_field:{name:'棉田',connected:true}, weaving_mill:{name:'织坊',connected:true},
  commercial_street:{name:'商业街',connected:true}, town_hall:{name:'政务厅',connected:true},
  livestock_base:{name:'养殖基地',connected:true}, times_square:{name:'时代广场',connected:true},
  police_station:{name:'警察局',connected:true}, social_security_office:{name:'社保局',connected:true},
  logistics_center:{name:'物流中心',connected:true}, dock:{name:'码头',connected:true}, trade_center:{name:'贸易中心',connected:true},
  school:{name:'学堂',connected:false}, clinic:{name:'医馆',connected:false},
  restaurant:{name:'饭馆',connected:false}, granary:{name:'粮仓',connected:false},
  housing:{name:'民居',connected:false}, tea_house:{name:'茶馆',connected:false}
});
const clamp=(v,a,b)=>Math.max(a,Math.min(b,Number(v)||a));
function roof(x,y,w,h){let seams='';for(let i=1;i<13;i++){const t=i/13;seams+=`<path d="M${x+w*.2+w*.69*t} ${y+2}L${x+w*.72*t} ${y+h*.47+h*.39*t}"/>`;}
return `<g stroke="#555f5d" stroke-width="1.05" stroke-linejoin="round"><path fill="#7e8984" d="M${x-7} ${y+h*.47}Q${x+w*.17} ${y+8} ${x+w*.2} ${y-5}L${x+w*.94} ${y+2}Q${x+w*.93} ${y+h*.35} ${x+w+10} ${y+h*.56}L${x+w*.74} ${y+h}Z"/><path fill="#596c68" d="M${x-7} ${y+h*.47}L${x+w*.74} ${y+h} ${x+w+10} ${y+h*.56} ${x+w*.76} ${y+h+6}Z"/><g opacity=".55" fill="none">${seams}<path d="M${x+4} ${y+h*.39}l${w*.76} ${h*.49}m${-w*.69} ${-h*.58}l${w*.76} ${h*.48}m${-w*.68} ${-h*.58}l${w*.75} ${h*.49}"/></g><path d="M${x+w*.2} ${y-5}l${w*.74} 7" stroke-width="2.5"/></g>`;}
function house(x=0,y=0,s=1,label='',tall=false){const extra=tall?23:0;return `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-45 ${-27-extra}L17 ${-5-extra}V34L-45 12Z" fill="#f4f0df"/><path d="M17 ${-5-extra}L48 ${-24-extra}V15L17 34Z" fill="#d5dbcc"/><path d="M-45 7L17 29 48 10v5L17 34-45 12Z" fill="#b4bbaa"/><path d="M-24-7l19 7v26l-19-7Z" fill="#967e5d"/><path d="M-14-3v26"/><path d="M-39-12l9 3V3l-9-3ZM1 3l9 3v12l-9-3ZM28-1l11-6V6l-11 6Z" fill="#9da48a"/><path d="M-35-10V1M5 5v11m28-19V8" stroke="#687465"/>
${tall?'<path d="M-38-32l11 4v10l-11-4ZM-17-24l11 4v10l-11-4ZM5-16l9 4v10l-9-4ZM27-20l12-7v11l-12 7Z" fill="#a1a68f"/><path d="M-45-9L17 13 48-6" fill="none"/>':''}
${roof(-56,-56-extra,102,43)}${label?`<path d="M-27-20l36 12v12L-27-8Z" fill="#52685e"/><text transform="matrix(1 .33 0 1 -9 -4)" text-anchor="middle" fill="#f8efd4" stroke="none" font-size="10" font-family="serif">${label}</text>`:''}</g>`;}
function courtyard(){return '<path d="M-67 10L-9-22 71 14 15 51Z" fill="#e2ddc5" stroke="#bfc3ad"/><path d="M-67 10v15l82 35 56-35V14L15 47Z" fill="#eae7d6"/><path d="M-67 10L15 47 71 14" fill="none" stroke="#6e7a6d" stroke-width="4"/>';}
function awning(x,y){return `<g transform="translate(${x} ${y})"><path d="M-34-5l53 18-10 14-53-18Z" fill="#d0bd91"/><path d="M-44 9v23M9 27v23" stroke="#8c7657" stroke-width="2"/><path d="M-36 25l40 14v6l-40-14Z" fill="#b59c71"/></g>`;}
function logs(){return `<g fill="#b39b70">${[0,1,2].map(i=>`<path d="M${-55+i*9} 27l27-15 7 5-27 15Z"/><ellipse cx="${-51+i*9}" cy="30" rx="5" ry="4" fill="#d3c292"/>`).join('')}</g>`;}
function jar(x,y){return `<g transform="translate(${x} ${y})"><path d="M-6-10Q-10-2-6 3Q0 6 6 3Q10-2 6-10Z" fill="#b08462" stroke="#7a5a43"/><ellipse cy="-10" rx="6.5" ry="2.2" fill="#8c6548" stroke="#6b4a36"/><path d="M-7-3h14" fill="none" stroke="#d8c59a" stroke-width="1.5"/></g>`;}
function wineJars(){return jar(-47,34)+jar(-34,40)+jar(-21,46)+jar(40,46);}
function wineFlag(){return `<path d="M58-46V8" fill="none" stroke="#79755b" stroke-width="2"/><path d="M58-46l19 5-4 7 4 7-19-5Z" fill="#9a5f48" stroke="#6e4534"/><path d="M56 8h5" stroke="#79755b" stroke-width="2"/>`;}
function cottonPlot(){
const L=[-62,14],T=[-8,-16],B=[12,42],R=[66,12];
const P=(u,v)=>[L[0]+u*(T[0]-L[0])+v*(B[0]-L[0]),L[1]+u*(T[1]-L[1])+v*(B[1]-L[1])].map(n=>+n.toFixed(1));
const pt=p=>p.join(' ');
let rows='',bushes='';
for(const v of [.45,.7,.92]){const a=P(.04,v),b=P(.96,v);rows+=`<path d="M${pt(a)}L${pt(b)}"/>`;
 for(const u of [.4,.62,.84]){const [x,y]=P(u,v);bushes+=`<ellipse cx="${x}" cy="${y}" rx="6.5" ry="4" fill="#8fa07a" stroke="#5f6e4f"/><circle cx="${x-2.5}" cy="${y-2}" r="1.8" fill="#fbfaf2" stroke="#9c9a80" stroke-width=".8"/><circle cx="${x+2.5}" cy="${y-1}" r="1.8" fill="#fbfaf2" stroke="#9c9a80" stroke-width=".8"/><circle cx="${x}" cy="${y+1.5}" r="1.6" fill="#fbfaf2" stroke="#9c9a80" stroke-width=".8"/>`;}}
let fence='';
for(const [a,b] of [[L,B],[B,R]]){const top=p=>[p[0],p[1]-7];fence+=`<path d="M${pt(top(a))}L${pt(top(b))}"/>`;
 for(let k=0;k<=5;k++){const t=k/5,x=a[0]+(b[0]-a[0])*t,y=a[1]+(b[1]-a[1])*t;fence+=`<path d="M${x} ${y-7}V${y}"/>`;}}
return `<path d="M${pt(L)}L${pt(T)}L${pt(R)}L${pt(B)}Z" fill="#dcd3a8" stroke="#b3ad8a"/><g fill="none" stroke="#c2b98f" stroke-width="1.4">${rows}</g>${bushes}<g fill="none" stroke="#8c7657" stroke-width="1.6">${fence}</g>`;}
function thatchShed(x,y,s){return `<g transform="translate(${x} ${y}) scale(${s})"><path d="M0 0L62 22V-8L0-30Z" fill="#f4f0df"/><path d="M62 22L93 3V-27L62-8Z" fill="#d5dbcc"/><path d="M0-30L62-8 77.5-27.5 15.5-49.5Z" fill="#c9b985"/><path d="M62-8L93-27 77.5-27.5Z" fill="#b3a474"/><path d="M18.6 6.6L34.1 12.1V-5.9L18.6-11.4Z" fill="#967e5d"/><g fill="none" stroke="#8a7a55" stroke-width="1" opacity=".7">${[1,2,3,4].map(k=>{const t=k/5;return `<path d="M${15.5*t} ${-30-19.5*t}L${62+15.5*t} ${-8-19.5*t}"/>`;}).join('')}</g></g>`;}
function clothRack(){return `<path d="M50 12V46M76 8V42M50 12H76" fill="none" stroke="#8a7456" stroke-width="2.5" stroke-linecap="round"/><g fill="#4f6078" stroke="#33405a" stroke-width=".8"><path d="M55 12h6v24l-3 3-3-3Z"/><path d="M63 12h6v30l-3 3-3-3Z"/><path d="M71 12h6v18l-3 3-3-3Z"/></g><path d="M56 22h4M64 26h4M72 19h4" stroke="#7d8ca3" stroke-width="1" fill="none"/><ellipse cx="60" cy="50" rx="9" ry="3.5" fill="#7d8ca3" stroke="#4a5873"/>`;}
/* 新增：养殖基地 / 时代广场 所用的小部件 */
function isoAt(L,T,B,u,v){return [L[0]+u*(T[0]-L[0])+v*(B[0]-L[0]),L[1]+u*(T[1]-L[1])+v*(B[1]-L[1])];}
function isoGround(L,T,B,fill,stroke){const R=[T[0]+B[0]-L[0],T[1]+B[1]-L[1]];return {R,svg:`<path d="M${L}L${T}L${R}L${B}Z" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>`};}
// 沿 a→b 的栅栏：立柱高 h，两道横杆；gap=[t1,t2] 留门洞
function fenceRun(a,b,n,h,gap){const at=t=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
const segs=gap?[[0,gap[0]],[gap[1],1]]:[[0,1]];let posts='',rails='';
for(const [s,e] of segs){const p0=at(s),p1=at(e);rails+=`M${p0[0]} ${p0[1]-h}L${p1[0]} ${p1[1]-h}M${p0[0]} ${p0[1]-h*.5}L${p1[0]} ${p1[1]-h*.5}`;
 for(let k=0;k<=n;k++){const [x,y]=at(s+(e-s)*k/n);posts+=`M${x} ${y-h}V${y}`;}}
return `<path d="${posts}"/><path d="${rails}" stroke-width="1.6"/>`;}
function hay(x,y,s=1){return `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cy="1" rx="13" ry="4.5" fill="#8c7a4e" opacity=".3" stroke="none"/><path d="M-12 0Q-13-14 0-16Q13-14 12 0Z" fill="#d7b86a" stroke="#9e8449"/><path d="M-7-12Q-3-5-7 0M0-15Q4-7 0 0M6-12Q9-6 7 0" fill="none" stroke="#b5964f" stroke-width=".8"/></g>`;}
function pig(x,y,s=1){return `<g transform="translate(${x} ${y}) scale(${s})" stroke="#8f7163" stroke-width=".9"><path d="M-4 2.5V6M3 2.5V6M-1.5 2.5V5.6M1.5 2.5V5.6" fill="none" stroke-width="1.2"/><path d="M-6.4-1Q-8.6-2 -8.8-4" fill="none"/><ellipse rx="6.5" ry="4" fill="#e8c7b4"/><ellipse cx="6" cy="-1" rx="3.4" ry="3" fill="#e8c7b4"/><ellipse cx="9.2" cy="-.6" rx="1.3" ry="1.1" fill="#c99b87"/><path d="M4.4-3L5.4-6.2L7.2-3.2Z" fill="#d8ad98"/><circle cx="7" cy="-2" r=".45" fill="#5d4a40" stroke="none"/></g>`;}
function chicken(x,y,s=1){return `<g transform="translate(${x} ${y}) scale(${s})" stroke="#8d8a72" stroke-width=".8"><path d="M-.5 2.4V4.6M1.5 2.4V4.6" fill="none"/><ellipse rx="3.4" ry="2.6" fill="#f6f2e2"/><path d="M-3-.6L-6-3L-4.5 1.2Z" fill="#e9e2cb"/><circle cx="3" cy="-3" r="1.8" fill="#f6f2e2"/><circle cx="3" cy="-4.9" r=".8" fill="#b8735a" stroke="none"/><path d="M4.6-3L7-2.3L4.6-1.8Z" fill="#d2a35e" stroke-width=".5"/></g>`;}
function duck(x,y,s=1){return `<g transform="translate(${x} ${y}) scale(${s})" stroke="#7d8b7c" stroke-width=".8"><ellipse rx="6" ry="1.6" fill="none" stroke="#eef3ea" stroke-width=".6"/><ellipse rx="4" ry="2.4" fill="#f3efdd"/><circle cx="3.2" cy="-2.8" r="1.9" fill="#8ea596"/><path d="M4.8-3L7.6-2.4L4.8-1.8Z" fill="#c99a5b" stroke-width=".5"/></g>`;}
function pond(x,y){return `<g transform="translate(${x} ${y})" stroke="#7f9188"><ellipse rx="17" ry="6.5" fill="#b8c9bf"/><ellipse cx="2" cy=".5" rx="10" ry="3.4" fill="#cadbd0" stroke="none"/><path d="M-15-2l-2-5M-12-3l0-5M14 3l2-4" fill="none" stroke="#7a8f5e" stroke-width="1.2"/></g>`;}
function livestockBase(level){
const L=[-67,10],T=[-9,-22],B=[15,51];const g=isoGround(L,T,B,'#d9d0a1','#a9a27d');
let dirt='';for(const [x,y,r] of [[-30,4,6],[30,12,5],[-2,36,7],[-44,22,4]])dirt+=`<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r*.42}" fill="#c6b07c" opacity=".45" stroke="none"/>`;
const fence=fenceRun(T,g.R,6,7)+fenceRun(g.R,B,7,7)+fenceRun(B,L,8,7,[.44,.58])+fenceRun(L,T,6,7);
// 猪圈（前右角菱形围栏）
const Q=[22,36],pen=[Q,[Q[0]+22,Q[1]-12],[Q[0],Q[1]-23],[Q[0]-22,Q[1]-11]];
const penFence=fenceRun(pen[0],pen[1],3,5)+fenceRun(pen[1],pen[2],3,5)+fenceRun(pen[2],pen[3],3,5)+fenceRun(pen[3],pen[0],3,5);
let animals='';
animals+=pig(14,24,.9)+(level>=3?pig(30,26,.85):'')+(level>=4?pig(22,18,.8):'');
for(const [x,y] of [[-50,10],[-40,20],[-8,12],[-60,6]].slice(0,level+1))animals+=chicken(x,y,1);
if(level>=4)animals+=chicken(-22,4,1);
if(level>=2){animals+=pond(-18,20)+duck(-24,18,.9)+duck(-12,22,.9);}else animals+=pond(-18,20);
if(level>=3)animals+=duck(-16,19,.8);
const haySt=hay(50,4,1)+(level>=3?hay(60,22,.8):'');
return `<g fill="none" stroke="#7b7c66">${dirt}</g>${g.svg}<path d="M${pen.map(p=>p.join(' ')).join('L')}Z" fill="#c2a878" opacity=".55" stroke="none"/><g fill="none" stroke="#7b7c66" stroke-width="1.2">${penFence}</g><g fill="none" stroke="#8c7657" stroke-width="1.6">${fence}</g>${house(-6,-16,.66,'牧')}${haySt}${animals}`;}
function stall(x,y,s,col,dark){return `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-20 14L26 26V34L-20 22Z" fill="#a8865f" stroke="#6e5538" stroke-width="1"/><ellipse cx="-11" cy="13" rx="4" ry="2" fill="#d1b47a" stroke="#8a7050" stroke-width=".6"/><ellipse cx="6" cy="18" rx="4" ry="2" fill="#b8c4a4" stroke="#7a8569" stroke-width=".6"/><ellipse cx="18" cy="21" rx="4" ry="2" fill="#c28f74" stroke="#8a5f4c" stroke-width=".6"/><path d="M-20-6V24M26 6V36" fill="none" stroke="#7a5f45" stroke-width="2"/><path d="M-20-6L26 6V12L-20 0Z" fill="${dark}" stroke="#6e5538" stroke-width=".8"/><path d="M-28-20L18-8L26 6L-20-6Z" fill="${col}" stroke="#6e5538" stroke-width="1"/><path d="M-5-14L3 0" fill="none" stroke="#f4efdc" stroke-width="1.6" opacity=".55"/></g>`;}
function person(x,y,s,col){return `<g transform="translate(${x} ${y}) scale(${s})" stroke="#6f6a52" stroke-width=".8"><path d="M-1.6 -.5V3.5M1.6 -.5V3.5" fill="none" stroke-width="1.2"/><path d="M-3.4-4.5Q0-6 3.4-4.5L4-.5H-4Z" fill="${col}"/><circle cy="-8" r="2.2" fill="#e6d3bb"/></g>`;}
function paifang(cx,by){const x=cx;return `<g transform="translate(${x} ${by})"><ellipse cx="-14" cy="3" rx="8" ry="3" fill="#cfcab2" stroke="none"/><ellipse cx="26" cy="3" rx="8" ry="3" fill="#cfcab2" stroke="none"/><path d="M-18-34h8v38h-8Z" fill="#9a5f48" stroke="#6e4534"/><path d="M-10-34l4-3v38l-4 3Z" fill="#7d4b39" stroke="#6e4534" stroke-width=".8"/><path d="M22-34h8v38h-8Z" fill="#9a5f48" stroke="#6e4534"/><path d="M30-34l4-3v38l-4 3Z" fill="#7d4b39" stroke="#6e4534" stroke-width=".8"/><path d="M-26-40h66v7h-66Z" fill="#8a5340" stroke="#6e4534"/><path d="M-6-31h22v17h-22Z" fill="#f1e7c8" stroke="#6e4534"/><text x="5" y="-18" text-anchor="middle" font-size="10" fill="#6e4534" stroke="none" font-family="serif">市</text><path d="M-6-14h22" stroke="#6e4534" stroke-width="2.5"/><path d="M-46-40Q-22-52 4-46Q30-52 56-40L51-33Q30-42 4-38Q-22-42-41-33Z" fill="#596c68" stroke="#3f4d4a"/><path d="M-46-40l-6-6M56-40l6-6" stroke="#3f4d4a" stroke-width="2.5" stroke-linecap="round"/><path d="M-30-41l6 6M-14-45l4 7M6-44v7M22-45l-4 7M40-41l-6 6" stroke="#8f9e98" stroke-width=".8" fill="none"/></g>`;}
function timesSquare(level){
const L=[-74,10],T=[-8,-30],B=[16,52];const g=isoGround(L,T,B,'#e6e1cb','#8f8a70');
let grid='';for(let k=1;k<5;k++){const a=isoAt(L,T,B,k/5,0),b=isoAt(L,T,B,k/5,1),c=isoAt(L,T,B,0,k/5),d=isoAt(L,T,B,1,k/5);grid+=`M${a}L${b}M${c}L${d}`;}
const palette=[['#9fb1a6','#7f9488'],['#c99a7d','#a37a62'],['#b9a77a','#978457'],['#8f9fb0','#72829a'],['#b8866f','#94685a'],['#d8cba8','#b5a882']];
const stalls=[[-50,0],[-24,14],[26,8],[44,4],[-2,28],[-38,30]];
const n=Math.min(stalls.length,level+2);
let stallSvg='';for(let i=0;i<n;i++){const [x,y]=stalls[i];const [c,d]=palette[i%palette.length];stallSvg+=stall(x,y,.62,c,d);}
const crowd=[[-30,-6,'#6f7f8e'],[10,-4,'#9c6f5a'],[-6,22,'#7e8a6c'],[36,22,'#b59c71'],[-58,14,'#8a7a6a'],[52,16,'#6f7f8e'],[20,38,'#9c6f5a'],[-18,40,'#7e8a6c'],[64,0,'#b59c71'],[-42,-2,'#9c6f5a']].slice(0,level*2+2);
const crowdSvg=crowd.map(([x,y,c])=>person(x,y,.8,c)).join('');
const flag=`<path d="M62-34V20" fill="none" stroke="#79755b" stroke-width="2"/><path d="M62-34l18 5-4 7 4 7-18-5Z" fill="#9a5f48" stroke="#6e4534"/><path d="M60 20h5" stroke="#79755b" stroke-width="2"/>`;
return `<path d="M${L}L${T}L${g.R}L${B}Z" fill="#e6e1cb" stroke="#8f8a70" stroke-width="1.5"/><path d="${grid}" fill="none" stroke="#bcb697" stroke-width=".8"/>${paifang(4,2)}${flag}${stallSvg}${crowdSvg}`;}
/* 运力相关：物流中心（敞口仓库 + 箱子 + 手推车）、码头（栈桥 + 小船）、贸易中心（大堂 + 旗幡） */
function warehouse(){return `<path d="M-52-4L12 18V46L-52 22Z" fill="#f4f0df"/><path d="M12 18L46-3V21L12 46Z" fill="#d5dbcc"/><path d="M-52 8L12 30 46 11" fill="none" stroke="#b4bbaa" stroke-width="1.6"/><path d="M-38 6L-6 15V42L-38 33Z" fill="#7d6a4c"/><path d="M-38 6L-6 15M-38 33L-6 42" stroke="#5e4f37" fill="none"/><path d="M-22 10.5V38.5M-28 24h12" stroke="#5e4f37" stroke-width="1" fill="none"/>${roof(-60,-38,112,40)}`;}
function crate(x,y,s=1){return `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-7 0l7 3.5 7-3.5v-8l-7-3.5-7 3.5Z" fill="#c9a86f" stroke="#7d6240"/><path d="M-7-8l7 3.5 7-3.5M0-4.5V3.5" fill="none" stroke="#7d6240"/></g>`;}
function handcart(x,y,s=1){return `<g transform="translate(${x} ${y}) scale(${s})" stroke="#6e5538" stroke-width="1.2"><path d="M-12-2L8-6 12 4 -8 8Z" fill="#b08a5e"/><path d="M-12-2L-22-8M-6 8l-9 8" fill="none" stroke-width="2"/><ellipse cx="-2" cy="12" rx="3.2" ry="3" fill="#5e4a33"/></g>`;}
function logisticsCenter(level){return warehouse()+crate(-30,40,1)+crate(-19,44,1)+(level>=3?crate(-40,44,1)+crate(-30,30,.9):'')+handcart(30,44,1.1);}
function dockScene(level){
const water=`<ellipse cx="18" cy="14" rx="66" ry="30" fill="#b9d3cc" stroke="#7f9f98" stroke-width="1.2"/><path d="M-30 30q6-4 12 0t12 0M20 40q6-4 12 0t12 0M-6 48q6-4 12 0" fill="none" stroke="#8fb6b0" stroke-width="1.4"/>`;
const pier=`<path d="M-34-8L50 22V34L-34 4Z" fill="#b08a5e" stroke="#6e5538"/><path d="M-20-2.8v12M0 4.2v12M20 11.2v12M36 16.8v12" stroke="#7d6240" fill="none"/><path d="M-30 4v9M-2 14v9M26 24v9" stroke="#5e4a33" stroke-width="2.5" fill="none"/>`;
const boat=`<path d="M3 44V20" stroke="#5e4a33" stroke-width="1.6" fill="none"/><path d="M3 20l12 16H3Z" fill="#f4efdc" stroke="#8c7657"/><path d="M-12 42h30l-5 9h-20Z" fill="#8a6a4b" stroke="#5e4a33"/><path d="M-12 42h30" stroke="#5e4a33" stroke-width="2"/>`;
const hut=level>=3?house(-36,-24,.46,'码'):'';
return water+pier+boat+hut;}
function banner(x,y,col='#9a5f48'){return `<g transform="translate(${x} ${y})"><path d="M0 0V-44" stroke="#79755b" stroke-width="2" fill="none"/><path d="M0-44l16 4-3 7 3 7-16-4Z" fill="${col}" stroke="#6e4534"/></g>`;}
function tradeCenter(level){return courtyard()+house(-4,-8,1.05,'贸',true)+banner(-56,-4)+banner(52,-10,'#52685e')+(level>=3?banner(-30,-22,'#b08a5e'):'')+awning(-22,24)+crate(44,44,.9);}
function renderComplete(type,level){
switch(type){
case 'logistics_center':return logisticsCenter(level);
case 'dock':return dockScene(level);
case 'trade_center':return tradeCenter(level);
case 'winery':return house(-8,-6,.92,'酒')+wineJars()+wineFlag();
case 'cotton_field':return cottonPlot()+thatchShed(-49,12,.6);
case 'weaving_mill':return house(-8,-6,.92,'织')+clothRack();
case 'public_housing': return courtyard()+house(-29,-9,.58)+house(27,7,.58)+house(-9,31,.58);
case 'commercial_street':return house(-32,-8,.66,'店')+house(25,13,.66,'铺')+awning(-17,5)+awning(36,26);
case 'wholesale_market':return house(0,-18,.88,'集')+awning(-28,13)+awning(31,32)+logs();
case 'mill':return house(-4,-3,.93,'磨')+`<g transform="translate(44 8)" stroke="#716f56" stroke-width="2"><ellipse rx="18" ry="25" fill="#aa9872"/><ellipse rx="12" ry="18" fill="#b9c8b0"/><path d="M0-25v50M-18 0h36M-13-18l26 36M-13 18l26-36" stroke-width="3"/><ellipse rx="3" ry="4" fill="#7a775b"/></g>`;
case 'bakery':return `<path d="M24-52l12-7 9 3v33l-12 6-9-5Z" fill="#b3ac94"/>`+house(0,0,1,'饼')+awning(-17,8)+`<g fill="#c4a369" stroke="#a58f62"><ellipse cx="-31" cy="36" rx="6" ry="3"/><ellipse cx="-17" cy="41" rx="6" ry="3"/></g>`;
case 'lumberyard':return house(16,-13,.72)+`<path d="M-46-9v29M-3 5v30M-46-9l43 14" stroke="#958665" stroke-width="4"/><path d="M-56-10l43 13 19-11-43-13Z" fill="#b6ac87"/>`+logs();
case 'bank':return courtyard()+house(0,-6,.98,'银号',true)+`<g fill="#babaa0"><path d="M-46 26l6-12 7 3 2 16Z M26 52l6-12 7 3 2 16Z"/></g>`;
case 'stock_exchange':return courtyard()+house(0,-8,1,'交易',true)+`<path d="M-50-20v48M55-12v44" stroke="#7a7861" stroke-width="2"/><path d="M-50-20l14 5v20l-14-5Z M55-12l14 5v20l-14-5Z" fill="#a9785c"/>`;
case 'saltworks':return house(16,-19,.7,'盐')+`<path d="M-61 10l39-20 46 21-39 23Z" fill="#c3d3c5"/><path d="M-54 12l17-9 18 9-17 10ZM-15 29l17-10 19 9-18 10Z" fill="#f9f5de"/><path d="M28 31l12-21 19 31Z" fill="#f3eed8"/>`;
case 'town_hall':return courtyard()+house(0,-5,1,'镇署')+`<path d="M-34 20l45 16v8l-45-16Z" fill="#c2c3ac"/>`;
case 'social_security_office':return courtyard()+house(0,-5,.96,'社保')+`<path d="M-34 20l45 16v8l-45-16Z" fill="#c8c6ae"/>`;
case 'police_station':return courtyard()+house(0,-5,.98,'巡署')+`<path d="M48-29v53" stroke="#79755b" stroke-width="2"/><path d="M48-29l17 5v22l-17-5Z" fill="#9a765c"/>`;
case 'school':return courtyard()+house(0,-10,1,'学堂');
case 'clinic':return house(0,0,1,'医馆')+awning(-10,8);
case 'restaurant':return house(0,0,1,'食肆',true)+awning(-10,8);
case 'tea_house':return house(0,0,1,'茶',true)+awning(-10,8);
case 'granary':return house(0,0,1.08,'粮')+logs();
case 'livestock_base':return livestockBase(level);
case 'times_square':return timesSquare(level);
default:return house(0,0,1,'',level>=3);
}}
export function renderBuildingArt(type,options={}){
const status=options.status||'complete';if(status==='empty')return '';
const level=Math.round(clamp(options.level||1,1,10)),scale=clamp(options.scale||1,.1,4);
let body='';
if(status==='construction'){
const progress=clamp(options.progress||0,0,1);
body=`<path d="M-57 4L-12-21 62 11 15 40Z" fill="#d8d6b8" stroke-dasharray="4 3"/><g stroke="#a08d67" stroke-width="3" fill="none"><path d="M-43 5v-42M14 26v-44M47 7v-39M-43-26L14-5 47-24M-43 5L14 26 47 7M-43-26L14 26M14-5L47 7"/></g><path d="M-45 45h90" stroke="#d4cfb5" stroke-width="5"/><path d="M-45 45h${90*progress}" stroke="#8e9d74" stroke-width="5"/>`;
}else body=modArt(MODS,type)?.({...options,level})??renderComplete(Object.hasOwn(BUILDING_ART_CATALOG,type)?type:'housing',level);
return `<g class="ink-building" transform="scale(${scale})" stroke="#7b7c66" stroke-width="1.1" stroke-linejoin="round"><ellipse cx="4" cy="36" rx="66" ry="17" fill="#7c8567" opacity=".10" stroke="none"/>${body}${status==='complete'&&level>1?`<g fill="#8b9c71" stroke="none">${Array.from({length:level},(_,i)=>`<circle cx="${-12+i*6}" cy="57" r="1.8"/>`).join('')}</g>`:''}</g>`;
}
export function buildingSVG(type,options={}) { return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-85 -100 170 180">${renderBuildingArt(type,options)}</svg>`; }
