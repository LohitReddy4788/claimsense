export const EXPENSE_CATEGORIES = ['Travel', 'Meals', 'Lodging', 'Communication', 'Other'] as const
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]

export interface CategoryResult {
  category: ExpenseCategory
  confidence: number
  reason: string
}

export interface LineItemCategory {
  description: string
  amount: number | null
  category: ExpenseCategory
  /** True when the line's own text named no category and it took the
   * receipt's category instead. */
  inherited: boolean
}
