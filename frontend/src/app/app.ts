import { Component, OnInit, OnDestroy, ViewChild, ElementRef, ChangeDetectorRef, NgZone, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit, OnDestroy {
  constructor(private cdr: ChangeDetectorRef, private ngZone: NgZone) {}

  // Toast notifications
  toasts: { id: string; message: string; type: string }[] = [];

  // Theme state
  theme = localStorage.getItem('sprint_grooming_theme') || 'light';

  // Session & user context states
  userContext = {
    id: '',
    name: '',
    avatar: '',
    color: '',
    role: '',
    roomId: '',
    isHost: false,
    isCoHost: false,
    sessionName: '',
    sessionPriority: 2,
    deckType: 'Fibonacci',
    votingStartAt: '',
    votingEndAt: ''
  };

  // Scheduled session window (Create Session form inputs, datetime-local strings)
  votingStartInput = '';
  votingEndInput = '';
  showScheduleForm = false;

  // Scheduled session window (synced from server, absolute UTC ISO strings)
  syncedVotingStartAt: string | null = null;
  syncedVotingEndAt: string | null = null;
  syncedExpiresAt: string | null = null;
  // Set when the server rejects a join because the session already expired
  sessionExpiredBlocked = false;
  sessionStatusInterval: any = null;

  // Admin session control (close / hand-off)
  sessionClosed = false;
  isAdminLeaveModalOpen = false;
  adminLeaveStep: 'options' | 'cohost' = 'options';
  isCloseSessionModalOpen = false;

  currentScreen: 'home' | 'board' = 'home';
  name = '';
  roomIdInput = '';
  joinAsSpectator = false;
  inviteRoomFound = false;
  lobbyTab: 'create' | 'join' = 'create';
  userId = '';

  // Validation errors
  errors = { name: '', roomId: '' };

  // Deck State
  deckType = 'Fibonacci';

  // Backlog and active estimation story target
  backlog: any[] = [];
  taskInfo: any = null;

  isEditingTask = false;
  editTitle = '';
  editDesc = '';
  newTicketTitle = '';
  newTicketDesc = '';
  newTicketPriority = 2;

  // Story import source tabs
  jiraTab: 'manual' | 'jira' | 'csv' = 'manual';

  // CSV Upload states
  csvStories: any[] = [];
  selectedCsvIds: string[] = [];
  csvError = '';
  csvFileName = '';

  // Jira Integration States
  jiraHost = 'https://your-company.atlassian.net';
  jiraEmail = '';
  jiraToken = '';
  jiraSprintId = '';
  isJiraDemo = false;
  isJiraConnected = false;
  jiraIssues: any[] = [];
  selectedJiraIssueIds: string[] = [];
  isJiraLoading = false;
  jiraError = '';

  // Settings states
  isSettingsOpen = false;
  isMembersListOpen = false;
  isNavbarMenuOpen = false;
  isProfileOpen = false;
  isCoAdminPopupOpen = false;
  selectedMemberForPromotion: any = null;
  profileName = '';
  settingsTitle = '';
  settingsDesc = '';
  settingsRole = 'Estimator';
  settingsDeck = 'Fibonacci';

  // Card selector & round states
  selectedCard: string | null = null;
  consensusValue = '';
  showVotes = false;
  participants: any[] = [];
  copied = false;
  copiedLink = false;
  expandedTicketId: string | null = null;

  // Discussion Timer states
  timerSeconds = 60;
  isTimerRunning = false;
  customTimerInput = '60';

  // Seating configuration theme properties
  COLOR_THEMES = [
    { name: 'blue', border: 'border-blue-500', text: 'text-blue-400', bg: 'bg-blue-500/10' },
    { name: 'indigo', border: 'border-indigo-500', text: 'text-indigo-400', bg: 'bg-indigo-500/10' },
    { name: 'emerald', border: 'border-emerald-500', text: 'text-emerald-400', bg: 'bg-emerald-500/10' },
    { name: 'rose', border: 'border-rose-500', text: 'text-rose-400', bg: 'bg-rose-500/10' },
    { name: 'amber', border: 'border-amber-500', text: 'text-amber-400', bg: 'bg-amber-500/10' },
    { name: 'purple', border: 'border-purple-500', text: 'text-purple-400', bg: 'bg-purple-500/10' }
  ];

  // Socket & Interval references
  socket: any = null;
  timerInterval: any = null;

  // Confetti Canvas elements reference
  @ViewChild('confettiCanvas') canvasRef!: ElementRef<HTMLCanvasElement>;
  private animationFrameId: number | null = null;
  private confettiActive = false;

  get socketUrl(): string {
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return 'http://127.0.0.1:3000';
    }
    return 'https://sprintgroomingtool-1.onrender.com';
  }

  // Pre-defined deck mapping helper
  get deckValues(): string[] {
    const DECK_VALUES_MAP = {
      Fibonacci: ["0.5", "1", "2", "3", "5", "8", "13", "20", "30", "50", "80", "?"],
      TShirt: ["XS", "S", "M", "L", "XL", "XXL", "?" ]
    };
    return (DECK_VALUES_MAP as any)[this.deckType] || DECK_VALUES_MAP.Fibonacci;
  }

  get selectedAvatar(): string {
    return this.name.trim() ? this.name.trim().charAt(0).toUpperCase() : 'U';
  }

  get selectedColor(): string {
    const colors = ['blue', 'indigo', 'emerald', 'rose', 'amber', 'purple'];
    if (!this.name.trim()) return 'indigo';
    const code = this.name.trim().charCodeAt(0);
    return colors[code % colors.length];
  }

  get adminUser(): any {
    return this.participants.find(p => p.isHost);
  }

  get coAdmins(): any[] {
    return this.participants.filter(p => p.isCoHost);
  }

  get canManageRoom(): boolean {
    return this.userContext.isHost || this.userContext.isCoHost;
  }

  get userRole(): string {
    return this.userContext.role || 'Estimator';
  }

  set userRole(val: string) {
    this.userContext.role = val;
  }

  // Calculations: average, agreement & std deviation getters
  get numericVotes(): number[] {
    return this.participants
      .filter(p => p.role === 'Estimator' && p.vote !== null && p.vote !== '?' && p.vote !== '☕')
      .map(p => {
        if (this.deckType === 'TShirt') {
          const map = { 'XS': 1, 'S': 2, 'M': 3, 'L': 5, 'XL': 8, 'XXL': 13 };
          return (map as any)[p.vote] || 0;
        }
        return parseFloat(p.vote);
      });
  }

  get totalNumericCount(): number {
    return this.numericVotes.length;
  }

  get voteAverage(): string | null {
    const votes = this.numericVotes;
    if (votes.length === 0) return null;
    const sum = votes.reduce((s, v) => s + v, 0);
    return (sum / votes.length).toFixed(1);
  }

  get stdDev(): number {
    const votes = this.numericVotes;
    if (votes.length <= 1) return 0;
    const avg = parseFloat(this.voteAverage!);
    const variance = votes.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / votes.length;
    return Math.sqrt(variance);
  }

  get agreement(): { title: string; color: string; desc: string } {
    const votingEstimators = this.participants.filter(p => p.role === 'Estimator');
    const votedCount = votingEstimators.filter(p => p.vote !== null).length;

    if (votedCount === 0) {
      return { title: "No Votes Cast", color: "text-slate-400", desc: "Select estimation cards to analyze results." };
    }
    if (votingEstimators.length > votedCount) {
      return { title: "Voting in Progress...", color: "text-indigo-400", desc: `Waiting for ${votingEstimators.length - votedCount} estimators...` };
    }

    const uniqueVotes = [...new Set(votingEstimators.map(p => p.vote))];
    if (uniqueVotes.length === 1) {
      return { title: "🎉 Perfect Consensus", color: "text-emerald-400", desc: "Unanimous agreement across the team!" };
    }

    if (this.deckType === 'TShirt') {
      return { title: "Estimates Revealed", color: "text-blue-400", desc: "Align on complexity and select consensus score." };
    }

    const std = this.stdDev;
    if (std < 1.5) {
      return { title: "🤝 High Agreement", color: "text-emerald-400", desc: "Estimates are close. Ready to lock standard points." };
    } else if (std < 4) {
      return { title: "⚖️ Moderate Agreement", color: "text-yellow-450", desc: "Slight scattering. Quick team alignment is suggested." };
    } else {
      return { title: "⚠️ Low Agreement", color: "text-rose-455", desc: "High variance! Developers should align on ticket complexity." };
    }
  }

  get isConsensusReached(): boolean {
    if (!this.showVotes) return false;
    const activeEstimators = this.participants.filter(p => p.role === 'Estimator');
    if (activeEstimators.length <= 1) return false;
    const firstVote = activeEstimators[0].vote;
    if (firstVote === null) return false;
    return activeEstimators.every(p => p.vote === firstVote);
  }

  ngOnInit() {
    this.applyTheme();

    // Check URL parameters for invites
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    const pathParts = window.location.pathname.split('/');
    const joinIdx = pathParts.indexOf('join');
    const hasJoinParam = (joinIdx !== -1 && pathParts[joinIdx + 1]) || roomParam;

    // Attempt restoring session context
    const saved = sessionStorage.getItem('sprint_grooming_user_context');
    if (saved) {
      try {
        const parsedContext = JSON.parse(saved);
        const targetRoom = roomParam || (joinIdx !== -1 ? decodeURIComponent(pathParts[joinIdx + 1]) : null);
        
        // If there is no specific target room in the URL, or if it matches our active session room, restore session
        if (!targetRoom || targetRoom === parsedContext.roomId) {
          this.userContext = parsedContext;
          this.name = this.userContext.name || '';
          this.roomIdInput = this.userContext.roomId || '';
          this.deckType = this.userContext.deckType || 'Fibonacci';
          this.currentScreen = 'board';
          this.jiraTab = 'manual';
          this.connectSocket();
        } else {
          // A different room link was clicked, show lobby to join the new room
          this.roomIdInput = targetRoom;
          this.inviteRoomFound = true;
          this.lobbyTab = 'join';
        }
      } catch (e) {
        if (hasJoinParam) {
          this.roomIdInput = roomParam || decodeURIComponent(pathParts[joinIdx + 1]);
          this.inviteRoomFound = true;
          this.lobbyTab = 'join';
        }
      }
    } else if (hasJoinParam) {
      this.roomIdInput = roomParam || decodeURIComponent(pathParts[joinIdx + 1]);
      this.inviteRoomFound = true;
      this.lobbyTab = 'join';
    }

    // Set unique session user ID
    let savedId = sessionStorage.getItem('sprint_grooming_user_id');
    if (!savedId) {
      savedId = Math.random().toString(36).substring(2, 9);
      sessionStorage.setItem('sprint_grooming_user_id', savedId);
    }
    this.userId = savedId;

    // Start background decr timer check
    this.startHostTimerInterval();
    // Keep the scheduled session status (upcoming/open/expired) fresh over time
    this.startSessionStatusInterval();
  }

  ngOnDestroy() {
    this.stopConfetti();
    if (this.timerInterval) clearInterval(this.timerInterval);
    if (this.sessionStatusInterval) clearInterval(this.sessionStatusInterval);
    if (this.socket) this.socket.disconnect();
  }

  // Re-evaluates the scheduled session status every second so the board flips
  // from Upcoming -> Voting Open -> Expired without needing a server event.
  startSessionStatusInterval() {
    if (this.sessionStatusInterval) {
      clearInterval(this.sessionStatusInterval);
    }
    let lastStatus = this.sessionStatus;
    this.sessionStatusInterval = setInterval(() => {
      if (this.currentScreen !== 'board' || !this.syncedVotingStartAt) return;
      const current = this.sessionStatus;
      if (current !== lastStatus) {
        if (current === 'open') {
          this.addToast('Voting is now open!', 'success');
        } else if (current === 'expired') {
          this.addToast('This voting session has expired.', 'info');
        }
        lastStatus = current;
      }
      this.cdr.detectChanges();
    }, 1000);
  }

  applyTheme() {
    if (this.theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('sprint_grooming_theme', this.theme);
  }

  toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    this.applyTheme();
  }

  toggleMembersList(event: Event) {
    event.stopPropagation();
    this.isMembersListOpen = !this.isMembersListOpen;
  }

  toggleNavbarMenu(event: Event) {
    event.stopPropagation();
    this.isNavbarMenuOpen = !this.isNavbarMenuOpen;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: Event) {
    this.isMembersListOpen = false;
    this.isNavbarMenuOpen = false;
  }

  addToast(message: string, type = 'info') {
    const id = Math.random().toString(36).substring(2, 9);
    this.ngZone.run(() => {
      this.toasts.push({ id, message, type });
      this.cdr.detectChanges();
    });
    setTimeout(() => {
      this.ngZone.run(() => {
        this.toasts = this.toasts.filter(t => t.id !== id);
        this.cdr.detectChanges();
      });
    }, 4000);
  }

  removeToast(id: string) {
    this.ngZone.run(() => {
      this.toasts = this.toasts.filter(t => t.id !== id);
      this.cdr.detectChanges();
    });
  }

  // Socket Connection and sync loops
  connectSocket() {
    if (this.socket) {
      this.socket.disconnect();
    }

    // Dynamic import to prevent bundler SSR complications (standalone bundle safe)
    import('socket.io-client').then(({ io }) => {
      this.socket = io(this.socketUrl);

      this.socket.on('connect', () => {
        this.ngZone.run(() => {
          this.addToast("Connected to grooming room!", "success");

          const selfPart = {
            id: this.userContext.id,
            name: this.userContext.name,
            avatar: this.userContext.avatar,
            color: this.userContext.color,
            role: this.userContext.role,
            vote: this.selectedCard,
            isHost: this.userContext.isHost,
            isCoHost: this.userContext.isCoHost
          };

          this.socket.emit('join-room', {
            roomId: this.userContext.roomId,
            user: selfPart,
            sessionName: this.userContext.sessionName,
            sessionPriority: this.userContext.sessionPriority || 3,
            deckType: this.userContext.deckType,
            votingStartAt: this.userContext.votingStartAt || null,
            votingEndAt: this.userContext.votingEndAt || null
          });
        });
      });

      this.socket.on('sync-state', (state: any) => {
        this.ngZone.run(() => {
          if (state.showVotes && !this.showVotes) {
            this.addToast("Discussion timer revealed!", "info");
          }
 
          this.taskInfo = state.taskInfo;
          this.backlog = state.backlog || [];
          this.showVotes = state.showVotes;

          if (state.sessionName) {
            this.userContext.sessionName = state.sessionName;
          }
          if (state.sessionPriority) {
            this.userContext.sessionPriority = state.sessionPriority;
          }

          // Scheduled session window (Feature 1)
          this.syncedVotingStartAt = state.votingStartAt || null;
          this.syncedVotingEndAt = state.votingEndAt || null;
          this.syncedExpiresAt = state.expiresAt || null;
          if (this.syncedVotingStartAt) {
            this.sessionExpiredBlocked = false;
          }

          // Admin session control: closed state
          const wasClosed = this.sessionClosed;
          this.sessionClosed = state.sessionClosed || false;
          if (this.sessionClosed && !wasClosed) {
            // Stop any running discussion timer once the session ends
            this.isTimerRunning = false;
            this.selectedCard = null;
          }
 
          if (state.deckType) {
            this.deckType = state.deckType;
          }
 
          const mappedParticipants = state.participants.map((p: any) => {
            if (p.id === this.userContext.id) {
              if (p.isHost !== this.userContext.isHost) {
                this.userContext.isHost = p.isHost;
                sessionStorage.setItem('sprint_grooming_user_context', JSON.stringify(this.userContext));
              }
              if ((p.isCoHost || false) !== this.userContext.isCoHost) {
                this.userContext.isCoHost = p.isCoHost || false;
                sessionStorage.setItem('sprint_grooming_user_context', JSON.stringify(this.userContext));
              }
              return { ...p, isSelf: true };
            }
            return { ...p, isSelf: false };
          });

          // Sort participants to ensure the Admin User (host) is always at the very top (index 0)
          // followed by isSelf (You) if not host, then sorted alphabetically by name
          mappedParticipants.sort((a: any, b: any) => {
            if (a.isHost && !b.isHost) return -1;
            if (!a.isHost && b.isHost) return 1;
            if (a.isSelf && !b.isSelf) return -1;
            if (!a.isSelf && b.isSelf) return 1;
            return a.name.localeCompare(b.name);
          });
 
          this.participants = mappedParticipants;

          const selfPart = state.participants.find((p: any) => p.id === this.userContext.id);
          if (selfPart) {
            if (!state.showVotes && selfPart.vote === null) {
              this.selectedCard = null;
            } else if (selfPart.vote !== null) {
              this.selectedCard = selfPart.vote;
            }
          }
 
          this.updateConsensusValue();
 
          // Canvas confetti check: only trigger on a fresh admin reveal, not on page refresh.
          if (state.showVotes && !this.showVotes && state.justRevealed) {
            this.startConfetti();
            if (this.canManageRoom) {
              this.handleLockEstimate(this.consensusValue);
            }
          } else if (!state.showVotes) {
            this.stopConfetti();
          }
          this.cdr.detectChanges();
        });
      });
 
      this.socket.on('timer-update', (data: any) => {
        this.ngZone.run(() => {
          const isRunning = data.isRunning;
          const seconds = data.seconds;
 
          if (isRunning && !this.isTimerRunning) {
            this.addToast("Discussion timer started! Cards will be automatically revealed on timeout.", "info");
          }
          this.isTimerRunning = isRunning;
          this.timerSeconds = seconds;
          this.cdr.detectChanges();
        });
      });

      this.socket.on('cohost-updated', (data: any) => {
        this.ngZone.run(() => {
          if (data?.message) {
            this.addToast(data.message, 'success');
          }
          this.cdr.detectChanges();
        });
      });

      // Scheduled session validation errors from the server (Feature 1)
      this.socket.on('session-error', (data: any) => {
        this.ngZone.run(() => {
          const msg = data?.message || 'This action is not allowed for the current session.';
          this.addToast(msg, 'error');
          if (data?.expired) {
            this.sessionExpiredBlocked = true;
          }
          if (data?.closed) {
            this.sessionClosed = true;
          }
          this.cdr.detectChanges();
        });
      });

      // Admin closed the session: voting ends for everyone
      this.socket.on('session-closed', (data: any) => {
        this.ngZone.run(() => {
          this.sessionClosed = true;
          this.isTimerRunning = false;
          this.addToast(data?.message || 'Voting is now closed for this session.', 'info');
          this.cdr.detectChanges();
        });
      });
    });
  }

  startHostTimerInterval() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }

    this.timerInterval = setInterval(() => {
      if (this.isTimerRunning && this.canManageRoom && this.socket) {
        if (this.timerSeconds <= 1) {
          this.isTimerRunning = false;
          this.timerSeconds = 0;
          this.socket.emit('timer-control', { isRunning: false, seconds: 0 });
          this.handleReveal();
          this.addToast("Discussion timer finished! Revealing card estimates automatically.", "info");
        } else {
          this.timerSeconds--;
          this.socket.emit('timer-control', { isRunning: true, seconds: this.timerSeconds });
        }
        this.cdr.detectChanges();
      }
    }, 1000);
  }

  updateConsensusValue() {
    const avg = this.voteAverage;
    if (avg !== null && this.showVotes) {
      const avgNum = parseFloat(avg);
      const deck = this.deckValues.filter(v => v !== '?' && v !== '☕');

      const numericDeck = deck.map(v => {
        if (this.deckType === 'TShirt') {
          const map = { 'XS': 1, 'S': 2, 'M': 3, 'L': 5, 'XL': 8, 'XXL': 13 };
          return { label: v, val: (map as any)[v] || 0 };
        }
        return { label: v, val: parseFloat(v) };
      });

      if (numericDeck.length > 0) {
        const closest = numericDeck.reduce((prev, curr) => {
          return Math.abs(curr.val - avgNum) < Math.abs(prev.val - avgNum) ? curr : prev;
        });
        this.consensusValue = closest.label;
      } else {
        this.consensusValue = this.deckValues[0];
      }
    } else if (!this.showVotes) {
      this.consensusValue = this.deckValues[0];
    }
  }

  // Start Session Launch Action
  handleStartSession(isHost: boolean) {
    this.errors = { name: '', roomId: '' };

    if (!this.name.trim()) {
      this.errors.name = "Please enter your name to continue";
      return;
    }

    let targetRoomId = '';
    if (isHost) {
      targetRoomId = 'EXL-' + Math.random().toString(36).substring(2, 7).toUpperCase();
    } else {
      if (!this.roomIdInput.trim()) {
        this.errors.roomId = "Please enter a Room ID";
        return;
      }
      targetRoomId = this.roomIdInput.trim();
    }

    const finalRole = this.joinAsSpectator ? 'Spectator' : 'Estimator';

    // Scheduled voting window (only applies when the host sets a start time)
    let votingStartIso = '';
    let votingEndIso = '';
    if (isHost && this.showScheduleForm && this.votingStartInput) {
      const start = new Date(this.votingStartInput);
      if (isNaN(start.getTime())) {
        this.addToast('Please enter a valid voting start date & time.', 'error');
        return;
      }
      if (start.getTime() <= Date.now()) {
        this.addToast('Voting start time must be in the future.', 'error');
        return;
      }
      votingStartIso = start.toISOString();

      if (this.votingEndInput) {
        const end = new Date(this.votingEndInput);
        if (isNaN(end.getTime())) {
          this.addToast('Please enter a valid voting end date & time.', 'error');
          return;
        }
        if (end.getTime() <= start.getTime()) {
          this.addToast('Voting end time must be after the start time.', 'error');
          return;
        }
        votingEndIso = end.toISOString();
      }
    }

    this.userContext = {
      id: this.userId,
      name: this.name.trim(),
      avatar: this.selectedAvatar,
      color: this.selectedColor,
      role: finalRole,
      roomId: targetRoomId,
      isHost,
      isCoHost: false,
      sessionName: isHost ? (this.sessionName.trim() || 'Sprint Session') : '',
      sessionPriority: isHost ? this.sessionPriority : 3,
      deckType: this.deckType,
      votingStartAt: votingStartIso,
      votingEndAt: votingEndIso
    };

    sessionStorage.setItem('sprint_grooming_user_context', JSON.stringify(this.userContext));
    this.currentScreen = 'board';
    this.jiraTab = 'manual';
    this.connectSocket();

    if (isHost) {
      this.addToast("You have created the room as the Admin User!", "success");
    }
  }

  // Card selector click handler
  handleCardSelect(val: string) {
    if (this.userRole === 'Spectator' || !this.taskInfo) return;

    // Enforce the scheduled voting window (Feature 1)
    if (this.sessionStatus === 'closed') {
      this.addToast('Voting is now closed for this session.', 'error');
      return;
    }
    if (this.sessionStatus === 'upcoming') {
      this.addToast('Voting has not started yet.', 'info');
      return;
    }
    if (this.sessionStatus === 'expired') {
      this.addToast('This voting session has expired.', 'error');
      return;
    }

    this.selectedCard = val;

    if (this.socket) {
      this.socket.emit('cast-vote', { vote: val });
    }
  }

  // Host: Action events
  handleReveal() {
    if (this.socket) {
      this.socket.emit('reveal-cards');
    }
  }

  handleResetRound() {
    this.selectedCard = null;
    if (this.socket) {
      this.socket.emit('reset-round');
    }
  }

  openCoAdminPopup(member: any) {
    if (this.userContext.isHost && !member.isHost && !member.isSelf) {
      this.selectedMemberForPromotion = member;
      this.isCoAdminPopupOpen = true;
    }
  }

  closeCoAdminPopup() {
    this.isCoAdminPopupOpen = false;
    this.selectedMemberForPromotion = null;
  }

  promoteToCoAdmin() {
    if (!this.userContext.isHost || !this.selectedMemberForPromotion || !this.socket) return;
    
    this.socket.emit('make-cohost', { userId: this.selectedMemberForPromotion.id });
    this.addToast(`${this.selectedMemberForPromotion.name} has been promoted to Co-Admin!`, 'success');
    this.closeCoAdminPopup();
  }

  handleDeckChange(type: string) {
    if (this.socket) {
      this.socket.emit('update-deck', { deckType: type });
    }
  }

  // Timer configuration actions
  handleTimerStart() {
    this.isTimerRunning = true;
    if (this.socket) {
      this.socket.emit('timer-control', { isRunning: true, seconds: this.timerSeconds });
    }
  }

  handleTimerPause() {
    this.isTimerRunning = false;
    if (this.socket) {
      this.socket.emit('timer-control', { isRunning: false, seconds: this.timerSeconds });
    }
  }

  handleTimerReset() {
    const sec = parseInt(this.customTimerInput, 10) || 60;
    this.timerSeconds = sec;
    this.isTimerRunning = false;
    if (this.socket) {
      this.socket.emit('timer-control', { isRunning: false, seconds: sec });
    }
  }

  handleSelectActiveTicket(ticket: any, currentBacklog = this.backlog) {
    if (!this.canManageRoom || !this.socket) return;
    if (ticket.estimate !== null || ticket.status === 'completed') return;

    const updatedBacklog = (currentBacklog || []).map(item => {
      if (item.id === ticket.id) return { ...item, status: 'active' };
      if (item.status === 'active') return { ...item, status: 'pending' };
      return item;
    });

    this.socket.emit('update-ticket', {
      taskInfo: { id: ticket.id, title: ticket.title, desc: ticket.desc, priority: ticket.priority }
    });
    this.socket.emit('update-backlog', { backlog: updatedBacklog });
  }

  handleAddBacklogTicket(e: Event) {
    e.preventDefault();
    if (!this.newTicketTitle.trim() || !this.socket) return;

    const newId = `TICKET-${Math.floor(Math.random() * 900) + 100}`;
    const newTicket = {
      id: newId,
      title: this.newTicketTitle.trim(),
      desc: this.newTicketDesc.trim(),
      priority: this.normalizePriority(this.newTicketPriority),
      estimate: null,
      status: 'pending',
      votesHistory: null,
      average: null,
      agreement: null
    };

    const currentBacklog = this.backlog || [];
    const updated = [...currentBacklog, newTicket];

    this.newTicketTitle = '';
    this.newTicketDesc = '';
    this.newTicketPriority = 2;

    // Set newly added ticket as active automatically
    const updatedWithActive = updated.map(item => {
      if (item.id === newId) return { ...item, status: 'active' };
      if (item.status === 'active') return { ...item, status: 'pending' };
      return item;
    });

    this.socket.emit('update-ticket', {
      taskInfo: { id: newTicket.id, title: newTicket.title, desc: newTicket.desc, priority: newTicket.priority }
    });
    this.socket.emit('update-backlog', { backlog: updatedWithActive });
    this.socket.emit('reset-round');
    this.addToast(`Ticket "${newTicket.title}" added and set as active target!`, 'success');
  }

  handleLockEstimate(consensusVal: string) {
    if (!this.canManageRoom || !this.socket || !this.taskInfo) return;

    const currentBacklog = this.backlog || [];
    const currentTask = this.taskInfo;

    const snapshotVotes = this.participants
      .filter(p => p.role === 'Estimator')
      .map(p => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        color: p.color,
        vote: p.vote
      }));

    const agreementText = this.agreement.title;
    const finalAverage = this.voteAverage;

    const updatedBacklog = currentBacklog.map(item => {
      if (item.id === currentTask.id) {
        return {
          ...item,
          estimate: consensusVal,
          status: 'completed',
          votesHistory: snapshotVotes,
          average: finalAverage,
          agreement: agreementText
        };
      }
      return item;
    });

    this.socket.emit('update-backlog', { backlog: updatedBacklog });
    this.socket.emit('reset-round');

    const nextPending = this.getSortedBacklog(updatedBacklog).find(item => item.status === 'pending');
    if (nextPending) {
      setTimeout(() => {
        this.handleSelectActiveTicket(nextPending, updatedBacklog);
      }, 1200);
    } else {
      this.socket.emit('update-ticket', { taskInfo: null });
    }
  }

  handleSaveTask(e: Event) {
    e.preventDefault();
    if (!this.editTitle.trim() || !this.socket || !this.taskInfo) return;

    const newInfo = {
      id: this.taskInfo.id,
      title: this.editTitle.trim(),
      desc: this.editDesc.trim(),
      priority: this.taskInfo.priority
    };

    this.socket.emit('update-ticket', { taskInfo: newInfo });

    const currentBacklog = this.backlog || [];
    const updatedBacklog = currentBacklog.map(item => {
      if (item.id === this.taskInfo.id) {
        return { ...item, title: this.editTitle.trim(), desc: this.editDesc.trim() };
      }
      return item;
    });
    this.socket.emit('update-backlog', { backlog: updatedBacklog });
    this.isEditingTask = false;
    this.addToast("Sprint details updated successfully!", "success");
  }

  handleSaveSettingsTask(title: string, desc: string) {
    if (!title.trim() || !this.socket) return;

    const taskId = this.taskInfo ? this.taskInfo.id : `TICKET-${Math.floor(Math.random() * 900) + 100}`;
    const existingTicket = (this.backlog || []).find(item => item.id === taskId);
    const priorityVal = existingTicket ? existingTicket.priority : 1;
    const newInfo = {
      id: taskId,
      title: title.trim(),
      desc: desc.trim(),
      priority: priorityVal
    };

    this.socket.emit('update-ticket', { taskInfo: newInfo });

    const currentBacklog = this.backlog || [];
    const exists = currentBacklog.some(item => item.id === taskId);
    let updatedBacklog;

    if (exists) {
      updatedBacklog = currentBacklog.map(item => {
        if (item.id === taskId) {
          return { ...item, title: title.trim(), desc: desc.trim() };
        }
        return item;
      });
    } else {
      updatedBacklog = [...currentBacklog, {
        id: taskId,
        title: newInfo.title,
        desc: newInfo.desc,
        priority: 1,
        estimate: null,
        status: 'active',
        votesHistory: null,
        average: null,
        agreement: null
      }];
    }

    this.socket.emit('update-backlog', { backlog: updatedBacklog });
    this.addToast("Sprint details updated successfully!", "success");
  }

  handleDeleteBacklogTicket(e: Event, ticketId: string) {
    e.stopPropagation();
    if (!this.canManageRoom || !this.socket) return;

    const currentBacklog = this.backlog || [];
    const updatedBacklog = currentBacklog.filter(item => item.id !== ticketId);

    this.socket.emit('update-backlog', { backlog: updatedBacklog });
    this.addToast(`Ticket "${ticketId}" removed from backlog!`, 'success');

    if (this.taskInfo && this.taskInfo.id === ticketId) {
      const nextPending = this.getSortedBacklog(updatedBacklog).find(item => item.status === 'pending');
      if (nextPending) {
        this.handleSelectActiveTicket(nextPending, updatedBacklog);
      } else {
        this.socket.emit('update-ticket', { taskInfo: null });
      }
    }
  }

  handleUpdateRole(newRole: string) {
    const updatedContext = { ...this.userContext, role: newRole };
    this.userContext = updatedContext;

    if (newRole === 'Spectator') {
      this.selectedCard = null;
    }

    if (this.socket) {
      this.socket.emit('join-room', {
        roomId: this.userContext.roomId,
        user: {
          ...updatedContext,
          vote: newRole === 'Spectator' ? null : this.selectedCard
        }
      });
    }
  }

  // ----- Admin session control: leave / close / hand-off (Feature) -----

  // Bound to the "Leave" button. Admins of an active, populated session get the
  // close/hand-off choices; everyone else (and closed sessions) leaves directly.
  requestLeave() {
    const otherParticipants = this.participants.filter(p => p.id !== this.userContext.id).length;
    if (this.userContext.isHost && !this.sessionClosed && otherParticipants > 0) {
      this.adminLeaveStep = 'options';
      this.isAdminLeaveModalOpen = true;
      return;
    }
    this.handleLeaveRoom();
  }

  cancelAdminLeave() {
    this.isAdminLeaveModalOpen = false;
    this.adminLeaveStep = 'options';
  }

  // Modal option 1: close the session for everyone, then leave.
  closeAndEndSession() {
    if (this.socket) {
      this.socket.emit('close-session', {});
    }
    // Hand the host a copy of the final report on the way out.
    this.handleDownloadSessionReport();
    this.addToast('Session closed. Final report downloaded.', 'success');
    this.isAdminLeaveModalOpen = false;
    // Give the close-session emit a moment to flush before disconnecting.
    setTimeout(() => this.handleLeaveRoom(), 400);
  }

  // Modal option 2: move to the participant picker for co-admin hand-off.
  goToCohostStep() {
    this.adminLeaveStep = 'cohost';
  }

  // Assign the chosen participant as Co-Admin, then leave.
  assignCohostAndLeave(member: any) {
    if (!member || !this.socket) return;
    this.socket.emit('make-cohost', { userId: member.id });
    this.addToast(`${member.name} is now Co-Admin and can manage the session.`, 'success');
    this.isAdminLeaveModalOpen = false;
    setTimeout(() => this.handleLeaveRoom(), 400);
  }

  // Direct "Close Session" control (Admin or Co-Admin), stays on the board.
  openCloseSessionModal() {
    if (!this.canManageRoom || this.sessionClosed) return;
    this.isCloseSessionModalOpen = true;
  }

  cancelCloseSession() {
    this.isCloseSessionModalOpen = false;
  }

  confirmCloseSession() {
    if (this.socket) {
      this.socket.emit('close-session', {});
    }
    this.isCloseSessionModalOpen = false;
    this.addToast('Voting is now closed for this session.', 'success');
  }

  // Build and download the final session report as CSV.
  handleDownloadSessionReport() {
    const headers = [
      'Session ID', 'Story ID', 'Story Title', 'Story Description', 'Priority',
      'Final Estimate', 'Average Vote', 'Agreement', 'Voting Status'
    ];

    const stories = (this.backlog || []).filter(item => item.id !== 'INFO');
    const rows = this.getSortedBacklog(stories).map(ticket => {
      const hasEstimate = ticket.estimate !== null && ticket.estimate !== undefined && ticket.estimate !== '';
      const votingStatus = hasEstimate ? 'Completed' : 'Closed (No Estimate)';
      return [
        this.userContext.roomId || '',
        ticket.id || '',
        ticket.title || '',
        ticket.desc || '',
        this.normalizePriority(ticket.priority),
        hasEstimate ? ticket.estimate : 'N/A',
        ticket.average || 'N/A',
        ticket.agreement || 'N/A',
        votingStatus
      ];
    });

    const csvContent = "data:text/csv;charset=utf-8,"
      + [headers.join(","), ...rows.map(e => e.map(val => `"${String(val).replace(/"/g, '""')}"`).join(","))].join("\n");

    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", encodeURI(csvContent));
    downloadAnchor.setAttribute("download", `EXL_Session_Final_Report_${this.userContext.roomId || 'session'}.csv`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    this.addToast("Final session report downloaded successfully!", "success");
  }

  handleLeaveRoom() {
    if (this.timerInterval) clearInterval(this.timerInterval);
    if (this.socket) this.socket.disconnect();
    this.addToast("You have left the session", "info");

    window.history.pushState({}, '', '/');
    sessionStorage.removeItem('sprint_grooming_user_context');

    this.inviteRoomFound = false;
    this.lobbyTab = 'create';
    this.currentScreen = 'home';
    this.userContext = { id: '', name: '', avatar: '', color: '', role: '', roomId: '', isHost: false, isCoHost: false, sessionName: '', sessionPriority: 2, deckType: 'Fibonacci', votingStartAt: '', votingEndAt: '' };    this.participants = [];
    this.backlog = [];
    this.taskInfo = null;
    this.selectedCard = null;
    this.showVotes = false;
    this.name = '';
    this.roomIdInput = '';
    // Reset scheduled-session + CSV state
    this.votingStartInput = '';
    this.votingEndInput = '';
    this.syncedVotingStartAt = null;
    this.syncedVotingEndAt = null;
    this.syncedExpiresAt = null;
    this.sessionExpiredBlocked = false;
    this.sessionClosed = false;
    this.isAdminLeaveModalOpen = false;
    this.adminLeaveStep = 'options';
    this.isCloseSessionModalOpen = false;
    this.clearCsv();
  }

  handleOpenSettings() {
    this.settingsTitle = this.taskInfo ? this.taskInfo.title : '';
    this.settingsDesc = this.taskInfo ? this.taskInfo.desc : '';
    this.settingsRole = this.userContext.role;
    this.settingsDeck = this.deckType;
    this.isSettingsOpen = true;
  }

  handleOpenProfile() {
    this.profileName = this.userContext.name;
    this.isProfileOpen = true;
  }

  handleSaveProfile() {
    if (!this.profileName.trim()) {
      this.addToast("Display name cannot be empty!", "error");
      return;
    }

    const newName = this.profileName.trim();
    const newAvatar = newName.charAt(0).toUpperCase();

    const updatedContext = {
      ...this.userContext,
      name: newName,
      avatar: newAvatar
    };

    this.userContext = updatedContext;
    sessionStorage.setItem('sprint_grooming_user_context', JSON.stringify(updatedContext));

    if (this.socket) {
      this.socket.emit('join-room', {
        roomId: this.userContext.roomId,
        user: {
          ...updatedContext,
          vote: this.userContext.role === 'Spectator' ? null : this.selectedCard
        }
      });
    }

    this.isProfileOpen = false;
    this.addToast("Display name updated successfully!", "success");
  }

  handleDownloadJSON() {
    const reportData = {
      room: this.userContext.roomId,
      sessionName: this.userContext.sessionName,
      ticketId: this.taskInfo?.id,
      ticketTitle: this.taskInfo?.title,
      ticketDesc: this.taskInfo?.desc,
      timestamp: new Date().toISOString(),
      average: this.voteAverage,
      agreement: this.agreement.title,
      voters: this.participants
        .filter(p => p.role === 'Estimator')
        .map(p => ({
          name: p.name,
          role: p.role,
          vote: p.vote || 'No Vote'
        }))
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(reportData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `EXL_Grooming_Report_${this.taskInfo?.id || 'room'}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    this.addToast("JSON report downloaded successfully!", "success");
  }

  handleDownloadCSV() {
    const headers = ["Session Room", "Ticket ID", "Ticket Title", "Average Score", "Consensus Status", "Voter Name", "Role", "Vote"];
    const rows = this.participants
      .filter(p => p.role === 'Estimator')
      .map(p => [
        this.userContext.roomId || '',
        this.taskInfo?.id || '',
        this.taskInfo?.title || '',
        this.voteAverage || '',
        this.agreement.title || '',
        p.name,
        p.role,
        p.vote || 'No Vote'
      ]);

    const csvContent = "data:text/csv;charset=utf-8,"
      + [headers.join(","), ...rows.map(e => e.map(val => `"${String(val).replace(/"/g, '""')}"`).join(","))].join("\n");

    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", encodeURI(csvContent));
    downloadAnchor.setAttribute("download", `EXL_Grooming_Report_${this.taskInfo?.id || 'room'}.csv`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    this.addToast("CSV report downloaded successfully!", "success");
  }

  get hasCompletedTickets(): boolean {
    return this.backlog.some(item => item.status === 'completed');
  }

  get completedTicketsCount(): number {
    return this.backlog.filter(item => item.status === 'completed').length;
  }

  handleDownloadSingleJSON(ticket: any) {
    const reportData = {
      room: this.userContext.roomId,
      sessionName: this.userContext.sessionName,
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      ticketDesc: ticket.desc,
      timestamp: new Date().toISOString(),
      average: ticket.average,
      agreement: ticket.agreement,
      estimate: ticket.estimate,
      voters: (ticket.votesHistory || []).map((p: any) => ({
        name: p.name,
        role: 'Estimator',
        vote: p.vote || 'No Vote'
      }))
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(reportData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `EXL_Grooming_Report_${ticket.id}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    this.addToast(`JSON report for ${ticket.id} downloaded successfully!`, "success");
  }

  handleDownloadSingleCSV(ticket: any) {
    const headers = ["Session Room", "Ticket ID", "Ticket Title", "Average Score", "Consensus Status", "Locked Estimate", "Voter Name", "Vote"];
    const rows = (ticket.votesHistory || []).map((p: any) => [
      this.userContext.roomId || '',
      ticket.id || '',
      ticket.title || '',
      ticket.average || '',
      ticket.agreement || '',
      ticket.estimate || '',
      p.name,
      p.vote || 'No Vote'
    ]);

    const csvContent = "data:text/csv;charset=utf-8,"
      + [headers.join(","), ...rows.map((e: any[]) => e.map((val: any) => `"${String(val).replace(/"/g, '""')}"`).join(","))].join("\n");

    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", encodeURI(csvContent));
    downloadAnchor.setAttribute("download", `EXL_Grooming_Report_${ticket.id}.csv`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    this.addToast(`CSV report for ${ticket.id} downloaded successfully!`, "success");
  }

  handleDownloadAllJSON() {
    const completed = this.backlog.filter(item => item.status === 'completed');
    const reportData = {
      room: this.userContext.roomId,
      sessionName: this.userContext.sessionName,
      timestamp: new Date().toISOString(),
      completedTicketsCount: completed.length,
      tickets: completed.map(ticket => ({
        ticketId: ticket.id,
        ticketTitle: ticket.title,
        ticketDesc: ticket.desc,
        average: ticket.average,
        agreement: ticket.agreement,
        estimate: ticket.estimate,
        voters: (ticket.votesHistory || []).map((p: any) => ({
          name: p.name,
          vote: p.vote || 'No Vote'
        }))
      }))
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(reportData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `EXL_Session_Grooming_Report_${this.userContext.roomId || 'room'}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    this.addToast("Consolidated JSON report downloaded successfully!", "success");
  }

  handleDownloadAllCSV() {
    const completed = this.backlog.filter(item => item.status === 'completed');
    const headers = ["Session Room", "Ticket ID", "Ticket Title", "Ticket Description", "Locked Estimate", "Average Score", "Consensus Status", "Voter Name", "Vote"];
    
    const rows: any[] = [];
    completed.forEach(ticket => {
      if (!ticket.votesHistory || ticket.votesHistory.length === 0) {
        rows.push([
          this.userContext.roomId || '',
          ticket.id || '',
          ticket.title || '',
          ticket.desc || '',
          ticket.estimate || '',
          ticket.average || '',
          ticket.agreement || '',
          'N/A',
          'N/A'
        ]);
      } else {
        ticket.votesHistory.forEach((p: any) => {
          rows.push([
            this.userContext.roomId || '',
            ticket.id || '',
            ticket.title || '',
            ticket.desc || '',
            ticket.estimate || '',
            ticket.average || '',
            ticket.agreement || '',
            p.name,
            p.vote || 'No Vote'
          ]);
        });
      }
    });

    const csvContent = "data:text/csv;charset=utf-8,"
      + [headers.join(","), ...rows.map((e: any[]) => e.map((val: any) => `"${String(val).replace(/"/g, '""')}"`).join(","))].join("\n");

    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", encodeURI(csvContent));
    downloadAnchor.setAttribute("download", `EXL_Session_Grooming_Report_${this.userContext.roomId || 'room'}.csv`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    this.addToast("Consolidated CSV report downloaded successfully!", "success");
  }

  handleCopyRoomId() {
    navigator.clipboard.writeText(this.userContext.roomId);
    this.copied = true;
    setTimeout(() => this.copied = false, 2000);
  }

  handleCopyInviteLink() {
    const inviteUrl = `${window.location.origin}/join/${encodeURIComponent(this.userContext.roomId)}`;
    navigator.clipboard.writeText(inviteUrl);
    this.copiedLink = true;
    setTimeout(() => this.copiedLink = false, 2000);
    this.addToast("Invite link copied to clipboard!", "success");
  }

  toggleExpandTicket(ticketId: string) {
    this.expandedTicketId = this.expandedTicketId === ticketId ? null : ticketId;
  }

  getCardStyles(val: string) {
    const values = this.deckValues;
    const idx = values.indexOf(val);

    const DECK_CARD_STYLES = [
      { bg: 'bg-amber-50', border: 'border-amber-200/80', borderActive: 'border-amber-500', text: 'text-amber-950', hover: 'hover:border-amber-400 hover:text-amber-800', dot: 'bg-amber-700' },
      { bg: 'bg-emerald-50', border: 'border-emerald-200/80', borderActive: 'border-emerald-500', text: 'text-emerald-950', hover: 'hover:border-emerald-400 hover:text-emerald-800', dot: 'bg-emerald-700' },
      { bg: 'bg-sky-50', border: 'border-sky-200/80', borderActive: 'border-sky-500', text: 'text-sky-950', hover: 'hover:border-sky-400 hover:text-sky-800', dot: 'bg-sky-700' },
      { bg: 'bg-violet-50', border: 'border-violet-200/80', borderActive: 'border-violet-500', text: 'text-violet-950', hover: 'hover:border-violet-400 hover:text-violet-800', dot: 'bg-violet-700' },
      { bg: 'bg-rose-50', border: 'border-rose-200/80', borderActive: 'border-rose-500', text: 'text-rose-950', hover: 'hover:border-rose-400 hover:text-rose-800', dot: 'bg-rose-700' }
    ];

    if (idx === -1) return DECK_CARD_STYLES[0];
    return DECK_CARD_STYLES[Math.floor(idx / 3) % DECK_CARD_STYLES.length];
  }

  // Get matching user seating color styles
  getUserTheme(colorName: string) {
    return this.COLOR_THEMES.find(t => t.name === colorName) || this.COLOR_THEMES[0];
  }

  // Seating layout math helpers
  getSeatingX(idx: number): number {
    const N = this.participants.length;
    if (N === 0) return 50;
    const angle = (idx * 2 * Math.PI) / N - Math.PI / 2;
    return 50 + 40 * Math.cos(angle);
  }

  getSeatingY(idx: number): number {
    const N = this.participants.length;
    if (N === 0) return 50;
    const angle = (idx * 2 * Math.PI) / N - Math.PI / 2;
    return 50 + 36 * Math.sin(angle);
  }

  get estimatorsVotedCount(): number {
    return this.participants.filter(p => p.role === 'Estimator' && p.vote !== null).length;
  }

  get estimatorsCount(): number {
    return this.participants.filter(p => p.role === 'Estimator').length;
  }

  get timerMinutes(): number {
    return Math.floor(this.timerSeconds / 60);
  }

  get timerSecondsPadded(): string {
    return (this.timerSeconds % 60).toString().padStart(2, '0');
  }

  get agreementPercentage(): string {
    if (this.totalNumericCount === 0) return '100%';
    const pct = Math.round(100 - this.stdDev * 15);
    return `${Math.max(10, pct)}%`;
  }

  get consensusChoices(): string[] {
    return this.deckValues.filter(v => v !== '?' && v !== '☕');
  }

  // ----- Priority helpers (Feature 2 & 3) -----
  // Coerce any incoming priority into a valid 1..3 integer; default to 2.
  normalizePriority(val: any): number {
    const n = parseInt(val, 10);
    if (!isNaN(n)) {
      if (n === 1) return 1;
      if (n === 2) return 2;
      if (n === 3) return 3;
      if (n === 4 || n === 5) return 1;
    }
    const s = String(val).toLowerCase();
    if (s.includes('high') || s.includes('p1')) return 1;
    if (s.includes('medium') || s.includes('p2')) return 2;
    if (s.includes('low') || s.includes('p3')) return 3;
    return 2;
  }

  // Badge label + theme classes for a story priority (1 High .. 3 Low)
  getPriorityMeta(priority: any): { label: string; cls: string } {
    const p = this.normalizePriority(priority);
    const LABELS: { [k: number]: string } = {
      1: 'P1: High',
      2: 'P2: Medium',
      3: 'P3: Low'
    };
    const STYLES: { [k: number]: string } = {
      1: 'bg-rose-500/10 dark:text-rose-500 text-rose-700 border-rose-500/25 dark:border-rose-500/25 border-rose-500/40',
      2: 'bg-amber-500/10 dark:text-amber-500 text-amber-800 border-amber-500/25 dark:border-amber-500/25 border-amber-500/40',
      3: 'bg-emerald-500/10 dark:text-emerald-400 text-emerald-700 border-emerald-500/25 dark:border-emerald-500/25 border-emerald-500/40'
    };
    return { label: LABELS[p], cls: STYLES[p] };
  }

  // Stable sort by priority (highest first), keeping the original import order
  // for stories that share a priority. INFO session card is always pinned first.
  getSortedBacklog(list: any[]): any[] {
    return (list || [])
      .map((t, i) => ({ t, i }))
      .sort((a, b) => {
        if (a.t.id === 'INFO' && b.t.id !== 'INFO') return -1;
        if (b.t.id === 'INFO' && a.t.id !== 'INFO') return 1;
        const pa = this.normalizePriority(a.t.priority);
        const pb = this.normalizePriority(b.t.priority);
        if (pb !== pa) return pa - pb;
        return a.i - b.i;
      })
      .map(x => x.t);
  }

  get sortedBacklog(): any[] {
    return this.getSortedBacklog(this.backlog);
  }

  // ----- Scheduled session window helpers (Feature 1) -----
  // 'none' => no schedule (legacy, always votable); otherwise upcoming/open/expired/closed
  get sessionStatus(): 'none' | 'upcoming' | 'open' | 'expired' | 'closed' {
    if (this.sessionClosed) return 'closed';
    if (!this.syncedVotingStartAt) return 'none';
    const now = Date.now();
    const start = new Date(this.syncedVotingStartAt).getTime();
    const exp = this.syncedExpiresAt ? new Date(this.syncedExpiresAt).getTime() : null;
    if (exp !== null && now > exp) return 'expired';
    if (now < start) return 'upcoming';
    return 'open';
  }

  get isVotingAllowed(): boolean {
    const s = this.sessionStatus;
    return s === 'none' || s === 'open';
  }

  get sessionStatusLabel(): string {
    switch (this.sessionStatus) {
      case 'upcoming': return 'Upcoming';
      case 'open': return 'Voting Open';
      case 'expired': return 'Expired';
      case 'closed': return 'Closed';
      default: return '';
    }
  }

  // Human-friendly schedule line shown on the board
  get sessionScheduleText(): string {
    if (!this.syncedVotingStartAt) return '';
    const fmt = (iso: string | null) => {
      if (!iso) return '';
      try {
        return new Date(iso).toLocaleString([], {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
      } catch {
        return '';
      }
    };
    if (this.sessionStatus === 'upcoming') {
      return `Voting opens ${fmt(this.syncedVotingStartAt)}`;
    }
    if (this.sessionStatus === 'expired') {
      return `Expired ${fmt(this.syncedExpiresAt)}`;
    }
    return `Voting closes ${fmt(this.syncedExpiresAt)}`;
  }

  // Lobby session name helper getter
  get sessionName(): string {
    return this.userContext.sessionName;
  }

  set sessionName(val: string) {
    this.userContext.sessionName = val;
  }

  get sessionPriority(): number {
    return Number(this.userContext.sessionPriority) || 2;
  }

  set sessionPriority(val: number) {
    this.userContext.sessionPriority = val;
  }

  getPriorityText(priority: any): string {
    const p = Number(priority);
    const map: Record<number, string> = {
      1: 'High',
      2: 'Medium',
      3: 'Low'
    };
    return map[p] || 'Medium';
  }

  startConfetti() {
    if (this.confettiActive) return;
    this.confettiActive = true;

    setTimeout(() => {
      const canvas = this.canvasRef?.nativeElement;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const resizeCanvas = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
      };
      resizeCanvas();
      window.addEventListener('resize', resizeCanvas);

      const colors = ['#fb4e0b', '#3b82f6', '#10b981', '#f43f5e', '#f59e0b'];
      const particles = Array.from({ length: 120 }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height - canvas.height,
        r: Math.random() * 4 + 2,
        color: colors[Math.floor(Math.random() * colors.length)],
        tilt: Math.random() * 8 - 4,
        tiltAngleIncremental: Math.random() * 0.05 + 0.02,
        tiltAngle: 0,
        speed: Math.random() * 3 + 2
      }));

      const draw = () => {
        if (!this.confettiActive) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        particles.forEach((p, idx) => {
          p.tiltAngle += p.tiltAngleIncremental;
          p.y += p.speed;
          p.x += Math.sin(p.tiltAngle) * 0.5;
          p.tilt = Math.sin(p.tiltAngle - idx / 3) * 10;

          ctx.beginPath();
          ctx.lineWidth = p.r;
          ctx.strokeStyle = p.color;
          ctx.moveTo(p.x + p.tilt + p.r / 2, p.y);
          ctx.lineTo(p.x + p.tilt, p.y + p.tilt + p.r / 2);
          ctx.stroke();
        });

        let activeParticles = false;
        particles.forEach(p => {
          if (p.y < canvas.height) {
            activeParticles = true;
          }
        });

        if (activeParticles && this.confettiActive) {
          this.animationFrameId = requestAnimationFrame(draw);
        } else {
          this.stopConfetti();
        }
      };

      draw();
    }, 100);
  }

  stopConfetti() {
    this.confettiActive = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  // Jira Integration Handlers
  async handleJiraConnectAndFetch() {
    this.isJiraLoading = true;
    this.jiraError = '';
    this.jiraIssues = [];
    this.selectedJiraIssueIds = [];

    if (!this.isJiraDemo) {
      if (!this.jiraHost.trim() || !this.jiraEmail.trim() || !this.jiraToken.trim() || !this.jiraSprintId.trim()) {
        this.jiraError = 'All fields are required when Demo Mode is disabled.';
        this.isJiraLoading = false;
        return;
      }
    }

    try {
      const response = await fetch(`${this.socketUrl}/api/jira/sprint`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          host: this.isJiraDemo ? 'https://demo.atlassian.net' : this.jiraHost.trim(),
          email: this.isJiraDemo ? 'demo@company.com' : this.jiraEmail.trim(),
          token: this.isJiraDemo ? 'demo_token_123' : this.jiraToken.trim(),
          sprintId: this.isJiraDemo ? 'demo-sprint-id' : this.jiraSprintId.trim(),
          isDemo: this.isJiraDemo
        })
      });

      const data = await response.json();
      if (response.ok && data.success) {
        this.ngZone.run(() => {
          this.jiraIssues = data.issues || [];
          this.selectedJiraIssueIds = (data.issues || []).map((issue: any) => issue.id);
          this.isJiraConnected = true;
          this.addToast(this.isJiraDemo ? 'Connected to Demo Jira Sprint successfully!' : 'Connected and synced with Jira Sprint!', 'success');
          this.cdr.detectChanges();
        });
      } else {
        this.ngZone.run(() => {
          this.jiraError = data.error || 'Failed to fetch Jira issues.';
          this.addToast('Jira connection failed.', 'error');
          this.cdr.detectChanges();
        });
      }
    } catch (err: any) {
      this.ngZone.run(() => {
        this.jiraError = err.message || 'Network error connecting to Jira.';
        this.addToast('Network error connecting to Jira.', 'error');
        this.cdr.detectChanges();
      });
    } finally {
      this.ngZone.run(() => {
        this.isJiraLoading = false;
        this.cdr.detectChanges();
      });
    }
  }

  handleImportJiraIssues() {
    if (this.selectedJiraIssueIds.length === 0 || !this.socket) return;

    const issuesToImport = this.jiraIssues.filter(issue => this.selectedJiraIssueIds.includes(issue.id));
    
    const newBacklogTickets = issuesToImport.map(issue => ({
      id: issue.id,
      title: issue.title,
      desc: issue.desc,
      priority: this.normalizePriority(issue.priority),
      estimate: null,
      status: 'pending',
      votesHistory: null,
      average: null,
      agreement: null
    }));

    const currentBacklog = this.backlog || [];
    const uniqueNewTickets = newBacklogTickets.filter(
      newTicket => !currentBacklog.some(existing => existing.id === newTicket.id)
    );

    if (uniqueNewTickets.length === 0) {
      this.addToast('All selected Jira tickets are already in the backlog.', 'info');
      return;
    }

    const updated = [...currentBacklog, ...uniqueNewTickets];
    this.socket.emit('update-backlog', { backlog: updated });
    
    this.addToast(`Successfully imported ${uniqueNewTickets.length} Jira tickets!`, 'success');
    
    if (!this.taskInfo || this.taskInfo.id === 'INFO') {
      const firstImported = this.getSortedBacklog(uniqueNewTickets)[0];
      this.socket.emit('update-ticket', {
        taskInfo: { id: firstImported.id, title: firstImported.title, desc: firstImported.desc, priority: firstImported.priority }
      });
      const updatedWithActive = updated.map(item => {
        if (item.id === firstImported.id) return { ...item, status: 'active' };
        if (item.status === 'active') return { ...item, status: 'pending' };
        return item;
      });
      this.socket.emit('update-backlog', { backlog: updatedWithActive });
    }
  }

  handleJiraToggleSelectAll() {
    if (this.selectedJiraIssueIds.length === this.jiraIssues.length) {
      this.selectedJiraIssueIds = [];
    } else {
      this.selectedJiraIssueIds = this.jiraIssues.map(issue => issue.id);
    }
  }

  handleJiraToggleSelect(id: string) {
    if (this.selectedJiraIssueIds.includes(id)) {
      this.selectedJiraIssueIds = this.selectedJiraIssueIds.filter(i => i !== id);
    } else {
      this.selectedJiraIssueIds.push(id);
    }
  }

  handleJiraDisconnect() {
    this.isJiraConnected = false;
    this.jiraIssues = [];
    this.selectedJiraIssueIds = [];
    this.jiraError = '';
    this.addToast('Jira connection closed.', 'info');
  }

  // ----- CSV Upload Handlers (Feature 2) -----

  // Tokenize a single CSV line respecting double-quoted fields
  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { current += '"'; i++; }
          else { inQuotes = false; }
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ',') { result.push(current); current = ''; }
        else current += ch;
      }
    }
    result.push(current);
    return result.map(c => c.trim());
  }

  // Parse full CSV text into story objects. Expects a header row containing at
  // least a "title" column; supported columns: id, title, desc, priority.
  private parseCsv(text: string): any[] {
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) {
      throw new Error('The CSV file is empty.');
    }

    const header = this.parseCsvLine(lines[0]).map(h => h.toLowerCase());
    const idx = {
      id: header.indexOf('id'),
      title: header.indexOf('title'),
      desc: header.findIndex(h => h === 'desc' || h === 'description'),
      priority: header.indexOf('priority')
    };

    if (idx.title === -1) {
      throw new Error('CSV must include a "title" column.');
    }

    const stories: any[] = [];
    let autoCounter = 1;
    for (let r = 1; r < lines.length; r++) {
      const cols = this.parseCsvLine(lines[r]);
      const title = (idx.title !== -1 ? cols[idx.title] : '') || '';
      if (!title.trim()) continue; // skip rows without a title

      let id = (idx.id !== -1 ? cols[idx.id] : '') || '';
      id = id.trim();
      if (!id) {
        id = `CSV-${String(autoCounter).padStart(3, '0')}`;
      }
      autoCounter++;

      const desc = (idx.desc !== -1 ? cols[idx.desc] : '') || '';
      const priorityRaw = idx.priority !== -1 ? cols[idx.priority] : '';

      stories.push({
        id,
        title: title.trim(),
        desc: desc.trim(),
        priority: this.normalizePriority(priorityRaw)
      });
    }

    if (stories.length === 0) {
      throw new Error('No valid stories found in the CSV file.');
    }

    // De-duplicate ids within the file itself (keep first occurrence)
    const seen = new Set<string>();
    return stories.filter(s => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
  }

  handleCsvFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files && input.files[0];
    if (!file) return;

    this.csvError = '';
    this.csvStories = [];
    this.selectedCsvIds = [];
    this.csvFileName = file.name;

    const reader = new FileReader();
    reader.onload = () => {
      this.ngZone.run(() => {
        try {
          const text = String(reader.result || '');
          const parsed = this.parseCsv(text);
          // Preview is shown sorted by priority (highest first), like the backlog
          this.csvStories = this.getSortedBacklog(parsed);
          this.selectedCsvIds = this.csvStories.map(s => s.id);
          this.addToast(`Parsed ${this.csvStories.length} stories from "${file.name}".`, 'success');
        } catch (err: any) {
          this.csvError = err?.message || 'Failed to parse CSV file.';
          this.addToast(this.csvError, 'error');
        }
        // Allow re-selecting the same file again later
        input.value = '';
        this.cdr.detectChanges();
      });
    };
    reader.onerror = () => {
      this.ngZone.run(() => {
        this.csvError = 'Could not read the selected file.';
        this.addToast(this.csvError, 'error');
        input.value = '';
        this.cdr.detectChanges();
      });
    };
    reader.readAsText(file);
  }

  handleCsvToggleSelectAll() {
    if (this.selectedCsvIds.length === this.csvStories.length) {
      this.selectedCsvIds = [];
    } else {
      this.selectedCsvIds = this.csvStories.map(s => s.id);
    }
  }

  handleCsvToggleSelect(id: string) {
    if (this.selectedCsvIds.includes(id)) {
      this.selectedCsvIds = this.selectedCsvIds.filter(i => i !== id);
    } else {
      this.selectedCsvIds.push(id);
    }
  }

  clearCsv() {
    this.csvStories = [];
    this.selectedCsvIds = [];
    this.csvError = '';
    this.csvFileName = '';
  }

  handleImportCsvStories() {
    if (this.selectedCsvIds.length === 0 || !this.socket) return;

    const storiesToImport = this.csvStories.filter(s => this.selectedCsvIds.includes(s.id));

    const newBacklogTickets = storiesToImport.map(story => ({
      id: story.id,
      title: story.title,
      desc: story.desc,
      priority: this.normalizePriority(story.priority),
      estimate: null,
      status: 'pending',
      votesHistory: null,
      average: null,
      agreement: null
    }));

    const currentBacklog = this.backlog || [];
    const uniqueNewTickets = newBacklogTickets.filter(
      newTicket => !currentBacklog.some(existing => existing.id === newTicket.id)
    );

    if (uniqueNewTickets.length === 0) {
      this.addToast('All selected stories are already in the backlog.', 'info');
      return;
    }

    const updated = [...currentBacklog, ...uniqueNewTickets];
    this.socket.emit('update-backlog', { backlog: updated });
    this.addToast(`Successfully imported ${uniqueNewTickets.length} stories from CSV!`, 'success');

    // Auto-activate the highest-priority imported story if nothing is active yet
    if (!this.taskInfo || this.taskInfo.id === 'INFO') {
      const firstImported = this.getSortedBacklog(uniqueNewTickets)[0];
      this.socket.emit('update-ticket', {
        taskInfo: { id: firstImported.id, title: firstImported.title, desc: firstImported.desc, priority: firstImported.priority }
      });
      const updatedWithActive = updated.map(item => {
        if (item.id === firstImported.id) return { ...item, status: 'active' };
        if (item.status === 'active') return { ...item, status: 'pending' };
        return item;
      });
      this.socket.emit('update-backlog', { backlog: updatedWithActive });
    }

    this.clearCsv();
  }
}
