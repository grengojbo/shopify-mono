// Звірка фактично списаної суми із сумою інвойсу перед mark-paid.
//
// `orderMarkAsPaid` позначає оплаченим увесь залишок замовлення, хоч би скільки
// насправді списано. Тому розбіжність (наприклад, часткове списання hold
// з кабінету mono) не можна мовчки перетворювати на «оплачено повністю».

import { kopecksToUahString } from './money';

/**
 * Фактично списана сума з відповіді mono. `finalAmount` необов'язковий у схемі
 * mono — тоді беремо `amount`. null означає, що суму визначити не вдалося;
 * викликач трактує це як розбіжність (fail-closed).
 */
export function resolvePaidAmount(finalAmount: unknown, amount: unknown): number | null {
  if (typeof finalAmount === 'number') {
    return finalAmount;
  }
  return typeof amount === 'number' ? amount : null;
}

export function amountMismatchMessage(details: {
  orderId: string;
  invoiceId: string;
  expectedKopecks: number;
  paidKopecks: number | null;
}): string {
  const paid =
    details.paidKopecks === null ? 'невідомо' : `${kopecksToUahString(details.paidKopecks)} грн`;
  return (
    `🚨 Сума оплати не збігається — замовлення ${details.orderId} НЕ позначено оплаченим\n` +
    `Інвойс: ${details.invoiceId}\n` +
    `Очікувалось: ${kopecksToUahString(details.expectedKopecks)} грн\n` +
    `Списано: ${paid}\n` +
    'Перевірте платіж у кабінеті mono і зафіксуйте оплату вручну.'
  );
}
