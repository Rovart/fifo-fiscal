import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Banknote, Coins, Copy, Gift, HandCoins, LogIn, LogOut, Percent, Receipt, Repeat, Sprout, Undo2, Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { OpKind } from '../../../shared/types.ts';

export const KIND_ICON: Record<OpKind, LucideIcon> = {
  buy: ArrowDownLeft, sell: ArrowUpRight, swap: Repeat, fx: ArrowLeftRight, dividend: Coins, interest: Percent, staking: Sprout, reward: Gift,
  return_capital: Undo2, fee: Receipt, deposit: Banknote, withdrawal: HandCoins, transfer_in: LogIn, transfer_out: LogOut, split: Copy, isin_change: Wallet,
};

export const COMMON_KINDS: OpKind[] = ['buy', 'sell', 'dividend', 'interest', 'swap', 'staking'];
export const OTHER_KINDS: OpKind[] = ['fx', 'reward', 'split', 'isin_change', 'return_capital', 'fee', 'deposit', 'withdrawal', 'transfer_in', 'transfer_out'];
