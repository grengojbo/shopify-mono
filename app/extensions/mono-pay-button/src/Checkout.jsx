// Кнопка «Сплатити через monobank» на Thank You сторінці (Path A, PRD §5, §10).
//
// Потік: orderId з Order API → POST {worker_url}/create-invoice із session
// token (Bearer) → рендер помітного банера з кнопкою-посиланням на pageUrl.
// Авто-редірект технічно неможливий (PRD §2) — кнопка, яку тисне покупець.

import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  // 'loading' | 'ready' | 'error' | 'hidden'
  const [state, setState] = useState('loading');
  const [pageUrl, setPageUrl] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function createInvoice() {
      const workerUrl = shopify.settings.value.worker_url;
      const orderId = shopify.orderConfirmation.value?.order?.id;
      if (!workerUrl || !orderId) {
        // Немає конфігурації або замовлення — нічого не показуємо
        setState('hidden');
        return;
      }

      try {
        const token = await shopify.sessionToken.get();
        const response = await fetch(`${workerUrl.replace(/\/$/, '')}/create-invoice`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ orderId }),
        });

        if (cancelled) return;

        if (response.status === 409) {
          // Замовлення вже оплачене — кнопка не потрібна
          setState('hidden');
          return;
        }
        if (!response.ok) {
          setState('error');
          return;
        }

        const data = await response.json();
        setPageUrl(data.pageUrl);
        setState('ready');
      } catch {
        if (!cancelled) {
          setState('error');
        }
      }
    }

    setState('loading');
    // createInvoice обробляє всі помилки всередині (setState('error'));
    // у useEffect await неможливий — явно ігноруємо проміс
    void createInvoice();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (state === 'hidden') {
    return null;
  }

  if (state === 'loading') {
    return (
      <s-banner tone="info">
        <s-spinner accessibilityLabel={shopify.i18n.translate('loading')} />{' '}
        {shopify.i18n.translate('loading')}
      </s-banner>
    );
  }

  if (state === 'error') {
    return (
      <s-banner tone="critical" heading={shopify.i18n.translate('errorTitle')}>
        <s-stack direction="block" gap="base">
          <s-text>{shopify.i18n.translate('errorBody')}</s-text>
          <s-button onClick={() => setAttempt((n) => n + 1)}>
            {shopify.i18n.translate('retry')}
          </s-button>
        </s-stack>
      </s-banner>
    );
  }

  return (
    <s-banner tone="warning" heading={shopify.i18n.translate('payTitle')}>
      <s-stack direction="block" gap="base">
        <s-text>{shopify.i18n.translate('payBody')}</s-text>
        <s-button variant="primary" href={pageUrl}>
          {shopify.i18n.translate('payButton')}
        </s-button>
      </s-stack>
    </s-banner>
  );
}
