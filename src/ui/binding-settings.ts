import { Setting } from 'obsidian';
import type { ChangeVaultBindingRequest, DshInstanceIdentity, VaultBindingSnapshot } from 'dsh-obsidian-bridge-protocol/binding';

export interface BindingSettingsOwner {
  bindingSnapshot(): VaultBindingSnapshot | undefined;
  discoverInstances(manualOrigin?: string): Promise<{ instances: DshInstanceIdentity[]; conflicts: number }>;
  changeVaultBinding(request: ChangeVaultBindingRequest): Promise<VaultBindingSnapshot>;
}

export function renderBindingSettings(container: HTMLElement, owner: BindingSettingsOwner, legacyOrigin: string): () => void {
  let snapshot = owner.bindingSnapshot(), candidates: DshInstanceIdentity[] = [], selected = '', manual = legacyOrigin, disposed = false, busy = false;
  const section = container.createDiv();
  section.createEl('h3', { text: '此 Vault 的 DSH 实例' });
  const status = section.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
  const summary = () => snapshot?.target
    ? `已绑定 ${snapshot.target.instanceId} · ${snapshot.target.profileId}（修订 ${snapshot.revision}）`
    : '尚未绑定。请选择已核验的实例；旧地址只是候选，不会自动建立绑定。';
  status.textContent = summary();
  let refreshDisabled: (disabled: boolean) => void = () => undefined;
  let manualDisabled: (disabled: boolean) => void = () => undefined;
  let bindDisabled: (disabled: boolean) => void = () => undefined;
  let unbindDisabled: (disabled: boolean) => void = () => undefined;
  let setOptions: (instances: DshInstanceIdentity[]) => void = () => undefined;
  const setBusy = (value: boolean) => { busy = value; refreshDisabled(value); manualDisabled(value); bindDisabled(value || !selected); unbindDisabled(value || !snapshot?.target); };
  const run = async (operation: () => Promise<string>) => {
    if (busy || disposed) return; setBusy(true); status.textContent = '正在核验并处理…';
    try { const message = await operation(); if (!disposed) { snapshot = owner.bindingSnapshot(); status.textContent = `${summary()} ${message}`; } }
    catch (error) { if (!disposed) status.textContent = `${summary()} ${error instanceof Error ? error.message : String(error)}`; }
    finally { if (!disposed) setBusy(false); }
  };
  new Setting(section).setName('手动发现地址').setDesc('可选。填写正在运行的 DSH Web 地址，不含登录令牌。')
    .addText(text => text.setValue(manual).onChange(value => { manual = value.trim(); }));
  new Setting(section).setName('可连接的实例').setDesc('先刷新本机发现；需要时也可核验手动地址。')
    .addDropdown(dropdown => {
      dropdown.addOption('', '请选择实例');
      dropdown.onChange(value => { selected = value; bindDisabled(busy || !selected); });
      setOptions = instances => {
        dropdown.selectEl.replaceChildren(); dropdown.addOption('', '请选择实例');
        instances.forEach((instance, index) => dropdown.addOption(String(index), `${instance.displayName} · ${instance.profileId} · ${instance.origin}`));
        selected = ''; dropdown.setValue('');
      };
    }).addButton(button => {
      refreshDisabled = disabled => { button.setDisabled(disabled); };
      button.setButtonText('刷新发现').onClick(() => void run(async () => {
        const result = await owner.discoverInstances(); candidates = result.instances;
        if (!disposed) setOptions(candidates); return `${candidates.length} 个可连接实例${result.conflicts ? `，${result.conflicts} 组身份冲突已暂停` : ''}。`;
      }));
    }).addButton(button => { manualDisabled = disabled => { button.setDisabled(disabled); }; button.setButtonText('核验手动地址').onClick(() => void run(async () => {
      const result = await owner.discoverInstances(manual); candidates = result.instances;
      if (!disposed) setOptions(candidates); return '地址核验完成，请选择后绑定。';
    })); });
  new Setting(section).setName('绑定管理').setDesc('改绑只影响后续操作。历史链接保留原实例，旧队列不会改投新实例。')
    .addButton(button => {
      bindDisabled = disabled => { button.setDisabled(disabled); };
      button.setButtonText('绑定 / 改绑所选实例').setCta().onClick(() => void run(async () => {
        const candidate = candidates[Number(selected)]; if (!candidate || selected === '' || !snapshot) throw new Error('请先刷新并选择实例');
        await owner.changeVaultBinding({ operationId: crypto.randomUUID(), expectedRevision: snapshot.revision, intent: snapshot.target ? 'rebind' : 'bind',
          target: { instanceId: candidate.instanceId, profileId: candidate.profileId }, candidate: { origin: candidate.origin, bootId: candidate.bootId } });
        return '绑定已保存，等待该实例建立连接。';
      }));
    }).addButton(button => {
      unbindDisabled = disabled => { button.setDisabled(disabled); };
      button.setButtonText('解除绑定').onClick(() => void run(async () => {
        if (!snapshot) throw new Error('绑定服务尚未就绪');
        await owner.changeVaultBinding({ operationId: crypto.randomUUID(), expectedRevision: snapshot.revision, intent: 'unbind', target: null });
        return '绑定已解除；历史引用和待处理记录仍保留。';
      }));
    });
  setBusy(false);
  return () => { disposed = true; };
}
