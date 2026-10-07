/**
 * 麦乡 · 江南建筑绘制库 v1.0 / 无外部依赖 / SVG
 * 单位：建筑锚点为地块中心，常规占地约 140×120。
 * HTML 已内嵌本库，无需与本文件放在一起。此文件用于后续开发。
 *
 * import { renderBuildingArt, BUILDING_ART_CATALOG } from './maixiang-buildings.js';
 * svg.innerHTML = renderBuildingArt('mill', {level: 1, status:'complete'});
 * 选项：level 1..5；scale 0.1..4；status 'empty'|'construction'|'complete'；progress 0..1。
 * empty 返回空字符串；construction 仅显示地基与脚手架；complete 显示建筑。
 * 本库只负责外观，不结算产出、就业、住房或银行业务。
 * 新增建筑：在目录加入类型，在 renderComplete 中添加对应分支。
 */
export const BUILDING_ART_CATALOG = Object.freeze({
  mill:{name:'磨坊',connected:true}, public_housing:{name:'公租房群',connected:true},
  bakery:{name:'面包房',connected:true}, lumberyard:{name:'伐木场',connected:true},
  stock_exchange:{name:'交易所',connected:true}, bank:{name:'银行',connected:true},
  saltworks:{name:'盐场',connected:true}, wholesale_market:{name:'批发市场',connected:true},
  commercial_street:{name:'商业街',connected:true}, town_hall:{name:'政务厅',connected:true},
  police_station:{name:'警察局',connected:true},
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
function renderComplete(type,level){
switch(type){
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
case 'police_station':return courtyard()+house(0,-5,.98,'巡署')+`<path d="M48-29v53" stroke="#79755b" stroke-width="2"/><path d="M48-29l17 5v22l-17-5Z" fill="#9a765c"/>`;
case 'school':return courtyard()+house(0,-10,1,'学堂');
case 'clinic':return house(0,0,1,'医馆')+awning(-10,8);
case 'restaurant':return house(0,0,1,'食肆',true)+awning(-10,8);
case 'tea_house':return house(0,0,1,'茶',true)+awning(-10,8);
case 'granary':return house(0,0,1.08,'粮')+logs();
default:return house(0,0,1,'',level>=3);
}}
export function renderBuildingArt(type,options={}){
const status=options.status||'complete';if(status==='empty')return '';
const level=Math.round(clamp(options.level||1,1,5)),scale=clamp(options.scale||1,.1,4);
let body='';
if(status==='construction'){
const progress=clamp(options.progress||0,0,1);
body=`<path d="M-57 4L-12-21 62 11 15 40Z" fill="#d8d6b8" stroke-dasharray="4 3"/><g stroke="#a08d67" stroke-width="3" fill="none"><path d="M-43 5v-42M14 26v-44M47 7v-39M-43-26L14-5 47-24M-43 5L14 26 47 7M-43-26L14 26M14-5L47 7"/></g><path d="M-45 45h90" stroke="#d4cfb5" stroke-width="5"/><path d="M-45 45h${90*progress}" stroke="#8e9d74" stroke-width="5"/>`;
}else body=renderComplete(Object.hasOwn(BUILDING_ART_CATALOG,type)?type:'housing',level);
return `<g class="ink-building" transform="scale(${scale})" stroke="#7b7c66" stroke-width="1.1" stroke-linejoin="round"><ellipse cx="4" cy="36" rx="66" ry="17" fill="#7c8567" opacity=".10" stroke="none"/>${body}${status==='complete'&&level>1?`<g fill="#8b9c71" stroke="none">${Array.from({length:level},(_,i)=>`<circle cx="${-12+i*6}" cy="57" r="1.8"/>`).join('')}</g>`:''}</g>`;
}
export function buildingSVG(type,options={}) { return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-85 -100 170 180">${renderBuildingArt(type,options)}</svg>`; }
