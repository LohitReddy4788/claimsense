export const EXPENSE_CATEGORIES = ['Travel', 'Meals', 'Lodging', 'Communication', 'Other'] as const
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]

export interface CategoryResult {
  category: ExpenseCategory
  confidence: number
  reason: string
}
