// Клієнт monobank acquiring API (PRD §6).
// Довідник: .claude/skills/monobank-acquiring/ (invoice.md, webhook.md, SKILL.md).
//
// Суми — цілі копійки, ccy=980. Жодних ретраїв тут: ретраї та звірка йдуть
// через Cron + D1 (PRD §3). Не-2xx відповідь — виняток MonoApiError
// (fail-closed); повідомлення помилок ніколи не містять токен.

const MONO_BASE_URL = 'https://api.monobank.ua';

export type PaymentType = 'debit' | 'hold';

/** Статуси живого API; `hold` відсутній у D1-схемі PRD §9 і мапиться на етапі вебхука. */
export type InvoiceStatusValue =
  | 'created'
  | 'processing'
  | 'hold'
  | 'success'
  | 'failure'
  | 'reversed'
  | 'expired';

export type BasketOrderItem = {
  name: string;
  qty: number;
  /** Ціна за одиницю в копійках (не за позицію — див. PRD §15.3). */
  sum: number;
  /** Код товару — обов'язковий для фіскалізації. */
  code: string;
  icon?: string;
  unit?: string;
  /** Сума за всі одиниці в копійках. */
  total?: number;
  uktzed?: string;
};

export type MerchantPaymInfo = {
  reference: string;
  destination: string;
  comment?: string;
  customerEmails?: string[];
  basketOrder?: BasketOrderItem[];
};

export type CreateInvoiceRequest = {
  /** Сума в копійках. */
  amount: number;
  ccy?: number;
  merchantPaymInfo?: MerchantPaymInfo;
  redirectUrl?: string;
  webHookUrl?: string;
  /** Строк дії інвойсу в секундах (типово 24 год). */
  validity?: number;
  paymentType?: PaymentType;
};

export type CreateInvoiceResponse = {
  invoiceId: string;
  pageUrl: string;
};

export type InvoiceStatusResponse = {
  invoiceId: string;
  status: InvoiceStatusValue;
  amount: number;
  ccy: number;
  finalAmount?: number;
  createdDate?: string;
  modifiedDate?: string;
  reference?: string;
  destination?: string;
  errCode?: string;
  failureReason?: string;
  paymentInfo?: {
    maskedPan: string;
    approvalCode?: string;
    rrn?: string;
    tranId?: string;
    terminal: string;
    paymentSystem: string;
    paymentMethod: string;
    fee?: number;
  };
};

export type FiscalizationItem = {
  name: string;
  qty: number;
  sum: number;
  code: string;
  uktzed?: string;
};

export type FinalizeInvoiceRequest = {
  invoiceId: string;
  /** Копійки; дозволяє частковий capture. */
  amount?: number;
  items?: FiscalizationItem[];
};

export type FinalizeInvoiceResponse = {
  status: 'success';
};

export type CancelInvoiceRequest = {
  invoiceId: string;
  amount?: number;
  extRef?: string;
  items?: FiscalizationItem[];
};

export type CancelInvoiceResponse = {
  status: 'processing' | 'success' | 'failure';
  createdDate: string;
  modifiedDate: string;
};

export class MonoApiError extends Error {
  readonly status: number;
  readonly errCode: string | undefined;
  readonly errText: string | undefined;

  constructor(status: number, errCode?: string, errText?: string) {
    super(`mono API ${status}${errCode ? ` ${errCode}` : ''}${errText ? `: ${errText}` : ''}`);
    this.name = 'MonoApiError';
    this.status = status;
    this.errCode = errCode;
    this.errText = errText;
  }
}

export type MonoClientOptions = {
  token: string;
  /** Ін'єкція fetch для тестів; типово — глобальний fetch Workers. */
  fetch?: typeof fetch;
};

export type MonoClient = {
  createInvoice(req: CreateInvoiceRequest): Promise<CreateInvoiceResponse>;
  invoiceStatus(invoiceId: string): Promise<InvoiceStatusResponse>;
  finalizeInvoice(req: FinalizeInvoiceRequest): Promise<FinalizeInvoiceResponse>;
  cancelInvoice(req: CancelInvoiceRequest): Promise<CancelInvoiceResponse>;
  /** Повертає base64-обгорнутий PEM — кешувати на боці виклику. */
  getPubkey(): Promise<string>;
};

export function createMonoClient(options: MonoClientOptions): MonoClient {
  const fetchImpl = options.fetch ?? fetch;

  async function request<T>(path: string, init?: { method: 'POST'; body: unknown }): Promise<T> {
    const response = await fetchImpl(`${MONO_BASE_URL}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'X-Token': options.token,
        ...(init ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init ? { body: JSON.stringify(init.body) } : {}),
    });

    if (!response.ok) {
      let errCode: string | undefined;
      let errText: string | undefined;
      try {
        const parsed = (await response.json()) as { errCode?: string; errText?: string };
        errCode = parsed.errCode;
        errText = parsed.errText;
      } catch {
        // Тіло помилки не JSON (напр., HTML від шлюзу) — залишаємо лише статус
      }
      throw new MonoApiError(response.status, errCode, errText);
    }

    return (await response.json()) as T;
  }

  return {
    createInvoice(req) {
      return request<CreateInvoiceResponse>('/api/merchant/invoice/create', {
        method: 'POST',
        body: req,
      });
    },
    invoiceStatus(invoiceId) {
      return request<InvoiceStatusResponse>(
        `/api/merchant/invoice/status?invoiceId=${encodeURIComponent(invoiceId)}`,
      );
    },
    finalizeInvoice(req) {
      return request<FinalizeInvoiceResponse>('/api/merchant/invoice/finalize', {
        method: 'POST',
        body: req,
      });
    },
    cancelInvoice(req) {
      return request<CancelInvoiceResponse>('/api/merchant/invoice/cancel', {
        method: 'POST',
        body: req,
      });
    },
    async getPubkey() {
      const { key } = await request<{ key: string }>('/api/merchant/pubkey');
      return key;
    },
  };
}
