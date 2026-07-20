export type EmployeeStatus = 'unbound' | 'active' | 'inactive' | 'archived';
export type SalaryVisibility = 'topic' | 'private' | 'admin-only';
export type WorkTaskStatus = 'queued' | 'pending' | 'completed' | 'cancelled' | 'failed';
export type DeliveryStatus = 'queued' | 'sent' | 'failed';
export type TelegramWorkMode = 'off' | 'polling' | 'webhook';

export interface WorkEmployee {
  id: string;
  fullName: string;
  defaultUnitRate: number;
  salaryVisibility: SalaryVisibility;
  status: EmployeeStatus;
  bindCode: string;
  telegramUserId?: string;
  telegramChatId?: string;
  telegramTopicId?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkTask {
  id: string;
  employeeId: string;
  description: string;
  deadline?: string;
  quantity: number;
  unitRate: number;
  amount: number;
  status: WorkTaskStatus;
  deliveryStatus: DeliveryStatus;
  deliveryError?: string;
  telegramChatId?: string;
  telegramTopicId?: number;
  telegramMessageId?: number;
  completedAt?: string;
  completedByUserId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EarningEntry {
  id: string;
  taskId: string;
  employeeId: string;
  quantity: number;
  unitRate: number;
  amount: number;
  status: 'active' | 'void';
  createdAt: string;
  voidedAt?: string;
}

export interface ProcessedTelegramUpdate {
  updateId: number;
  outcome: string;
  processedAt: string;
}

export interface TelegramWorkState {
  version: 1;
  pollingOffset: number;
  employees: WorkEmployee[];
  tasks: WorkTask[];
  earnings: EarningEntry[];
  processedUpdates: ProcessedTelegramUpdate[];
}

export interface EmployeeTotals {
  pendingTasks: number;
  todayQuantity: number;
  todayAmount: number;
  monthQuantity: number;
  monthAmount: number;
  allQuantity: number;
  allAmount: number;
}

export interface WorkEmployeeDto extends WorkEmployee {
  totals: EmployeeTotals;
}

export interface PayrollRow {
  employeeId: string;
  fullName: string;
  defaultUnitRate: number;
  totals: EmployeeTotals;
}

export interface TelegramReaction {
  type: string;
  emoji?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    message_thread_id?: number;
    text?: string;
    chat: { id: number | string; type?: string };
    from?: { id: number | string; first_name?: string; username?: string };
  };
  message_reaction?: {
    chat: { id: number | string; type?: string };
    message_id: number;
    user?: { id: number | string; first_name?: string; username?: string };
    actor_chat?: { id: number | string };
    old_reaction: TelegramReaction[];
    new_reaction: TelegramReaction[];
  };
}
