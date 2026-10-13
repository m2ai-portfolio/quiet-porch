import { chromium } from '/home/apexaipc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
const dir='/home/apexaipc/Documents/Codex/2026-10-12/task/quiet-porch-current/docs/delivery/browser-validation';
const browser=await chromium.launch({executablePath:'/home/apexaipc/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[]; const results=[]; const warnings=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error') {const loc=m.location(); (loc.url.endsWith('/favicon.ico') ? warnings : errors).push({text:m.text(),url:loc.url});}});
page.on('requestfailed',r=>errors.push(r.url()+': '+r.failure()?.errorText));
const check=(name,ok,detail)=>{results.push({name,passed:!!ok,detail}); if(!ok) throw Error(name+': '+detail);};
await page.goto('http://10.0.0.46:3472'); await page.waitForFunction(()=>document.querySelector('#health').textContent.length>0);
const original=await page.request.get('http://10.0.0.46:3472/api/state').then(r=>r.json());
const action=async(a)=>{const r=await page.request.post('http://10.0.0.46:3472/api/action',{data:a}); if(!r.ok())throw Error('action failed');};
const clickAndWait=async(id)=>{const response=page.waitForResponse(r=>r.url().endsWith('/api/action')); await page.locator(id).click(); await response; await page.waitForFunction(()=>document.querySelector('#error').textContent==='');};
const scenario=async(v)=>{await page.locator('#scenario').selectOption(v);await clickAndWait('#load');await page.waitForFunction(v=>document.querySelector('#scenario').value===v,v);};
try {
 check('LAN document rendered',await page.title()==='Quiet Porch · Rehearsal',await page.title());
 check('Synthetic safety label visible',await page.getByText('NO PHYSICAL OUTPUTS', {exact:true}).isVisible(),'No physical outputs');
 await scenario('night'); await page.screenshot({path:dir+'/desktop-night.png',fullPage:true});
 check('Night ledger populated',await page.locator('#ledger details').count()>0,await page.locator('#ledger details').count());
 await page.locator('#ledger summary').first().click();check('Ledger evidence expands',await page.locator('#ledger pre').first().isVisible(),'expanded');
 await page.locator('#filter').selectOption('unknown');check('Unknown filter applies',await page.locator('#ledger details').count()===0,'night has no unknown rows');await page.locator('#filter').selectOption('all');
 await scenario('active'); check('Active incident exposed',await page.locator('#stop').isEnabled(),await page.locator('#active').innerText());await clickAndWait('#stop'); await page.waitForFunction(()=>document.querySelector('#stop').disabled);check('Stand down clears incident',await page.locator('#stop').isDisabled(),await page.locator('#active').innerText());
 await scenario('active'); await clickAndWait('#expect');await page.waitForFunction(()=>!document.querySelector('#cancel').disabled);check('Expected window closes active incident',await page.locator('#stop').isDisabled(),'Stop disabled, cancel enabled');await clickAndWait('#cancel');await page.waitForFunction(()=>document.querySelector('#cancel').disabled);check('Cancel does not resurrect stopped incident',await page.locator('#stop').isDisabled(),'stop remains disabled');
 for(const v of ['empty','historical','secondary']) {await scenario(v);check('Scenario '+v+' renders',(await page.locator('#health').innerText()).length>0,await page.locator('#report').innerText());await page.screenshot({path:dir+'/'+v+'.png',fullPage:true});}
 await page.locator('#note').fill('Browser validation synthetic note');await clickAndWait('#save'); await page.reload(); await page.waitForFunction(()=>document.querySelector('#note').value==='Browser validation synthetic note');check('Review note survives browser reload',true,'saved note restored');
 await page.setViewportSize({width:390,height:844});await scenario('night');await page.screenshot({path:dir+'/mobile-night.png',fullPage:true});const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,viewport:innerWidth}));check('Mobile no horizontal overflow',dimensions.scroll<=dimensions.viewport,dimensions);
 await page.setViewportSize({width:1366,height:768});await page.screenshot({path:dir+'/surface-night.png',fullPage:true});
 check('JavaScript and network error-free',errors.length===0,errors);
} finally {
 await action({action:'scenario',scenario:original.scenario});await action({action:'note',note:original.note}); if(original.expected)await action({action:'expect'});if(original.stopped)await action({action:'stop'});
 await fs.writeFile(dir+'/results.json',JSON.stringify({browser:await browser.version(),url:'http://10.0.0.46:3472',results,errors,warnings,restoredOriginalPreferences:true},null,2));await browser.close();
}
console.log(JSON.stringify(results,null,2));
