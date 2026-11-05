export type QuestionType = 'mcq' | 'tf' | 'scale' | 'open';

export interface Session {
  id: string;
  code: string;
  title: string;
  current_slide: number;
  active_question_id: string | null;
  show_results: boolean;
  reveal_answer: boolean;
  is_active: boolean;
  created_at: string;
}

export interface Question {
  id: string;
  session_id: string;
  title: string;
  type: QuestionType;
  options: string[];
  correct_option: string | null;
  slide_number: number | null;
  is_open: boolean;
  order_index: number;
  created_at: string;
}

export interface Participant {
  id: string;
  session_id: string;
  nickname: string;
  created_at: string;
}

export interface Vote {
  id: string;
  session_id: string;
  question_id: string;
  participant_id: string;
  answer: string;
  created_at: string;
}

export interface CreateQuestionInput {
  session_id: string;
  title: string;
  type: QuestionType;
  options: string[];
  correct_option?: string | null;
  slide_number?: number | null;
  is_open?: boolean;
  order_index?: number;
}

export interface UpdateQuestionInput {
  title?: string;
  type?: QuestionType;
  options?: string[];
  correct_option?: string | null;
  slide_number?: number | null;
  is_open?: boolean;
  order_index?: number;
}

export interface SessionRealtimeCallbacks {
  onSessionUpdate?: (session: Session) => void;
  onQuestionsChange?: (questions: Question[]) => void;
  onParticipantsChange?: (participants: Participant[]) => void;
  onVotesChange?: (votes: Vote[]) => void;
}

export interface PowerPointStatus {
  connected: boolean;
  inSlideShow: boolean;
  presentationName: string | null;
  currentSlide: number;
  totalSlides: number;
  slideTitle?: string;
  slideText?: string;
  isVoteSlide?: boolean;
  propositionSlide?: number;
  propositionTitle?: string;
  slideButtonClicked?: boolean;
}

export interface UpdateSlideButtonPayload {
  slideNumber: number;
  isOpen: boolean;
  voteCount: number;
  ouiCount: number;
  nonCount: number;
  abstCount: number;
}

export interface InsertResultSlidePayload {
  slideNumber: number;
  questionTitle: string;
  ouiCount: number;
  ouiPct: number;
  nonCount: number;
  nonPct: number;
  abstCount: number;
  abstPct: number;
  totalVotes: number;
  sessionCode: string;
}

export interface PowerPointBridgeAPI {
  isElectron: boolean;
  setWindowMode: (
    mode: 'trigger' | 'panel' | 'modal' | 'dashboard' | 'overlay'
  ) => Promise<{ mode: string }>;
  setIgnoreMouseEvents: (ignore: boolean) => void;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  getStatus: () => Promise<PowerPointStatus | null>;
  nextSlide: () => Promise<PowerPointStatus | null>;
  prevSlide: () => Promise<PowerPointStatus | null>;
  gotoSlide: (slideNumber: number) => Promise<PowerPointStatus | null>;
  startSlideShow: () => Promise<PowerPointStatus | null>;
  endSlideShow: () => Promise<PowerPointStatus | null>;
  syncQrSlides?: (qrDataUrl: string) => Promise<PowerPointStatus | null>;
  insertResultSlide?: (
    payload: InsertResultSlidePayload
  ) => Promise<PowerPointStatus | null>;
  updateSlideButton?: (
    payload: UpdateSlideButtonPayload
  ) => Promise<PowerPointStatus | null>;
}

