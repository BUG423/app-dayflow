const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createRuntime} = require('./helpers/miniprogram');
const {shiftDays} = require('../miniprogram/utils/calendar');
const pagesRoot=path.resolve(__dirname,'../miniprogram/pages');
test('中文产品界面不含静态英文装饰或英文导航标题',()=>{
  for(const dir of fs.readdirSync(pagesRoot)){
    const file=path.join(pagesRoot,dir,'index.wxml');
    const visible=fs.readFileSync(file,'utf8').replace(/{{[\s\S]*?}}/g,'').replace(/<[^>]+>/g,'');
    assert.doesNotMatch(visible,/[A-Za-z]/,dir+' visible text');
    const config=JSON.parse(fs.readFileSync(path.join(pagesRoot,dir,'index.json'),'utf8'));
    if(config.navigationBarTitleText)assert.doesNotMatch(config.navigationBarTitleText,/[A-Za-z]/,dir+' navigation title');
  }
  const app=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../miniprogram/app.json'),'utf8'));
  assert.doesNotMatch(app.window.navigationBarTitleText,/[A-Za-z]/);
  app.tabBar.list.forEach(item=>assert.doesNotMatch(item.text,/[A-Za-z]/));
});
test('内置七日示例的用户可见内容保持中文，技术标识不参与文案检查',()=>{
  const {getBlocksForDate}=createRuntime().load('miniprogram/data/template.ts');
  for(let offset=0;offset<7;offset++){
    const blocks=getBlocksForDate(shiftDays('2026-10-26',offset));
    for(const block of blocks){
      assert.doesNotMatch(block.title,/[A-Za-z]/);
      for(const action of block.actions){
        for(const key of ['title','dosage','description','equipment','searchKeyword','safety']){
          if(action[key])assert.doesNotMatch(action[key],/[A-Za-z]/,key+': '+action[key]);
        }
      }
    }
  }
});
