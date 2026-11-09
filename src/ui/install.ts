type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function setupInstallButton(button: HTMLButtonElement, notify: (message: string) => void): void {
  if (isStandalone()) {
    button.hidden = true;
    return;
  }

  let deferred: InstallPromptEvent | null = null;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    button.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    button.hidden = true;
    notify('インストールしました。ホーム画面から起動できます。');
  });

  if (isIos) button.hidden = false;

  button.addEventListener('click', async () => {
    if (deferred) {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      deferred = null;
      if (choice.outcome === 'accepted') button.hidden = true;
      return;
    }
    if (isIos) {
      notify('Safari の共有ボタン →「ホーム画面に追加」でインストールできます。');
      return;
    }
    notify('ブラウザのメニューから「アプリをインストール」を選んでください。');
  });
}
