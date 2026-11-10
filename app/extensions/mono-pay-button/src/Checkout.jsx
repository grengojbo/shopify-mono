// Кнопка «Сплатити через monobank» на Thank You сторінці (Path A, PRD §5, §10).
//
// Потік: orderId і номер підтвердження з Order API → POST {worker_url}/create-invoice із session
// token (Bearer) → рендер помітного банера з кнопкою-посиланням на pageUrl.
// Авто-редірект технічно неможливий (PRD §2) — кнопка, яку тисне покупець.

import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

// Платіжна сторінка mono: pay.monobank.ua — бойова, pay.mbnk.biz — з офіційної документації.
const MONO_PAY_HOSTS = ['pay.monobank.ua', 'pay.mbnk.biz'];

// Кнопка веде покупця платити — посилання з відповіді Worker'а приймається лише
// якщо це https-сторінка mono. Будь-що інше (підміна worker_url у налаштуваннях,
// зламаний Worker) закінчується помилкою, а не переходом на чужий сайт.
function isMonoPayUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && MONO_PAY_HOSTS.includes(url.hostname);
  } catch {
    // Не URL — так само не довіряємо
    return false;
  }
}

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
          // Номер підтвердження доводить Worker'у, що запит — зі сторінки саме
          // цього замовлення (orderId сам по собі можна підставити будь-який)
          body: JSON.stringify({
            orderId,
            confirmationNumber: shopify.orderConfirmation.value?.number,
          }),
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
        if (cancelled) return;
        if (!isMonoPayUrl(data?.pageUrl)) {
          setState('error');
          return;
        }
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
