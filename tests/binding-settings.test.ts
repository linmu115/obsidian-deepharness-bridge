import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { renderBindingSettings } from '../src/ui/binding-settings.ts';
import type { DshInstanceIdentity, VaultBindingSnapshot } from 'dsh-obsidian-bridge-protocol/binding';
vi.mock('obsidian', () => ({ Setting: class {
  element: HTMLElement;
  constructor(container: HTMLElement) { this.element = container.appendChild(document.createElement('div')); }
  setName(value: string) { this.element.appendChild(document.createElement('label')).textContent = value; return this; }
  setDesc(value: string) { this.element.appendChild(document.createElement('p')).textContent = value; return this; }
  addText(build: (component: any) => void) { const input = this.element.appendChild(document.createElement('input')); const component = { setValue(value: string) { input.value = value; return component; }, onChange(callback: (value: string) => void) { input.onchange = () => callback(input.value); return component; } }; build(component); return this; }
  addDropdown(build: (component: any) => void) { const select = this.element.appendChild(document.createElement('select')); const component = { selectEl: select, addOption(value: string, text: string) { const option = new Option(text, value); select.appendChild(option); return component; }, setValue(value: string) { select.value = value; return component; }, onChange(callback: (value: string) => void) { select.onchange = () => callback(select.value); return component; } }; build(component); return this; }
  addButton(build: (component: any) => void) { const button = this.element.appendChild(document.createElement('button')); const component = { setButtonText(value: string) { button.textContent = value; return component; }, setDisabled(value: boolean) { button.disabled = value; return component; }, setCta() { return component; }, onClick(callback: () => void) { button.onclick = callback; return component; } }; build(component); return this; }
} }));
let dom: JSDOM;
afterEach(() => { dom.window.close(); vi.unstubAllGlobals(); });
beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>');
  for (const name of ['document', 'HTMLElement', 'Option', 'Event'] as const) vi.stubGlobal(name, dom.window[name]);
  document.body.innerHTML = '';
  Object.assign(HTMLElement.prototype, { createDiv(this: HTMLElement) { return this.appendChild(document.createElement('div')); }, createEl(this: HTMLElement, tag: string, options: { text?: string; attr?: Record<string, string> }) { const element = this.appendChild(document.createElement(tag)); element.textContent = options.text ?? ''; for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value); return element; } });
});
function fixture() {
  const candidate: DshInstanceIdentity = { discoveryProtocolVersion: 1, kind: 'dsh', instanceId: 'instance', profileId: 'web', bootId: crypto.randomUUID(), publisherId: crypto.randomUUID(), displayName: 'My DSH', origin: 'http://127.0.0.1:3030', capabilities: ['vault-instance-binding-v1'] };
  let snapshot: VaultBindingSnapshot = { bindingProtocolVersion: 1, vaultId: 'vault', target: null, revision: 0, updatedAt: 0 };
  const owner = { bindingSnapshot: () => snapshot, discoverInstances: vi.fn(async () => ({ instances: [candidate], conflicts: 0 })), changeVaultBinding: vi.fn(async (request: any) => { snapshot = { ...snapshot, target: request.target, revision: snapshot.revision + 1 }; return snapshot; }) };
  const dispose = renderBindingSettings(document.body, owner, candidate.origin);
  const button = (name: string) => [...document.querySelectorAll('button')].find(button => button.textContent === name)!;
  return { owner, candidate, button, dispose };
}
it('does not implicitly bind and submits explicit bind then unbind with visible confirmed status', async () => {
  const f = fixture(); expect(f.owner.changeVaultBinding).not.toHaveBeenCalled(); expect(document.body.textContent).toContain('尚未绑定');
  expect(f.button('绑定 / 改绑所选实例').disabled).toBe(true); f.button('刷新发现').click();
  await vi.waitFor(() => expect(document.querySelectorAll('option')).toHaveLength(2));
  const select = document.querySelector('select')!; select.value = '0'; select.dispatchEvent(new Event('change'));
  f.button('绑定 / 改绑所选实例').click();
  await vi.waitFor(() => expect(document.body.textContent).toContain('绑定已保存'));
  expect(f.owner.changeVaultBinding).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 0, intent: 'bind', target: { instanceId: 'instance', profileId: 'web' }, candidate: { origin: f.candidate.origin, bootId: f.candidate.bootId } }));
  f.button('解除绑定').click(); await vi.waitFor(() => expect(document.body.textContent).toContain('绑定已解除'));
  expect(f.owner.changeVaultBinding).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 1, intent: 'unbind', target: null })); f.dispose();
});
it('keeps an unsuccessful change unconfirmed and reports errors beside the form', async () => {
  const f = fixture(); f.owner.discoverInstances.mockRejectedValueOnce(new Error('实例当前不可用'));
  f.button('刷新发现').click(); await vi.waitFor(() => expect(document.querySelector('[role=status]')?.textContent).toContain('实例当前不可用'));
  expect(document.body.textContent).toContain('尚未绑定'); expect(f.owner.changeVaultBinding).not.toHaveBeenCalled(); f.dispose();
});
