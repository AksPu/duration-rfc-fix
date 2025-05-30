/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/Components.h"
#include "msgCore.h"
#include "nsIAppStartup.h"
#include "nsMsgSearchCore.h"
#include "nsMsgSearchSession.h"
#include "nsMsgSearchTerm.h"
#include "nsMsgSearchScopeTerm.h"
#include "nsIMsgMessageService.h"
#include "nsMsgUtils.h"
#include "nsIMsgSearchNotify.h"
#include "nsIMsgMailSession.h"
#include "nsIMsgWindow.h"
#include "nsMsgFolderFlags.h"
#include "nsMsgLocalSearch.h"
#include "nsComponentManagerUtils.h"
#include "nsServiceManagerUtils.h"

NS_IMPL_ISUPPORTS(nsMsgSearchSession, nsIMsgSearchSession, nsIUrlListener,
                  nsISupportsWeakReference)

nsMsgSearchSession::nsMsgSearchSession() {
  m_sortAttribute = nsMsgSearchAttrib::Sender;
  m_idxRunningScope = 0;
  m_handlingError = false;
  m_expressionTree = nullptr;
  m_searchPaused = false;
  m_iListener = -1;
  m_searchRunning = false;
}

nsMsgSearchSession::~nsMsgSearchSession() {
  InterruptSearch();
  delete m_expressionTree;
  DestroyScopeList();
  DestroyTermList();
}

NS_IMETHODIMP
nsMsgSearchSession::AddSearchTerm(nsMsgSearchAttribValue attrib,
                                  nsMsgSearchOpValue op,
                                  nsIMsgSearchValue* value, bool BooleanANDp,
                                  const char* customString) {
  // stupid gcc
  nsMsgSearchBooleanOperator boolOp;
  if (BooleanANDp)
    boolOp = (nsMsgSearchBooleanOperator)nsMsgSearchBooleanOp::BooleanAND;
  else
    boolOp = (nsMsgSearchBooleanOperator)nsMsgSearchBooleanOp::BooleanOR;
  nsMsgSearchTerm* pTerm =
      new nsMsgSearchTerm(attrib, op, value, boolOp, customString);
  NS_ENSURE_TRUE(pTerm, NS_ERROR_OUT_OF_MEMORY);

  m_termList.AppendElement(pTerm);
  // force the expression tree to rebuild whenever we change the terms
  delete m_expressionTree;
  m_expressionTree = nullptr;
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchSession::AppendTerm(nsIMsgSearchTerm* aTerm) {
  NS_ENSURE_ARG_POINTER(aTerm);
  delete m_expressionTree;
  m_expressionTree = nullptr;
  m_termList.AppendElement(aTerm);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchSession::GetSearchTerms(nsTArray<RefPtr<nsIMsgSearchTerm>>& terms) {
  terms = m_termList.Clone();
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchSession::SetSearchTerms(
    nsTArray<RefPtr<nsIMsgSearchTerm>> const& terms) {
  m_termList = terms.Clone();
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchSession::CreateTerm(nsIMsgSearchTerm** aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  NS_ADDREF(*aResult = new nsMsgSearchTerm);
  return NS_OK;
}

NS_IMETHODIMP nsMsgSearchSession::RegisterListener(
    nsIMsgSearchNotify* aListener, int32_t aNotifyFlags) {
  NS_ENSURE_ARG_POINTER(aListener);
  m_listenerList.AppendElement(aListener);
  m_listenerFlagList.AppendElement(aNotifyFlags);
  return NS_OK;
}

NS_IMETHODIMP nsMsgSearchSession::UnregisterListener(
    nsIMsgSearchNotify* aListener) {
  NS_ENSURE_ARG_POINTER(aListener);
  size_t listenerIndex = m_listenerList.IndexOf(aListener);
  if (listenerIndex != m_listenerList.NoIndex) {
    m_listenerList.RemoveElementAt(listenerIndex);
    m_listenerFlagList.RemoveElementAt(listenerIndex);

    // Adjust our iterator if it is active.
    // Removal of something at a higher index than the iterator does not affect
    // it; we only care if the the index we were pointing at gets shifted down,
    // in which case we also want to shift down.
    if (m_iListener != -1 && (signed)listenerIndex <= m_iListener)
      m_iListener--;
  }

  return NS_OK;
}

NS_IMETHODIMP nsMsgSearchSession::GetNumSearchTerms(uint32_t* aNumSearchTerms) {
  NS_ENSURE_ARG(aNumSearchTerms);
  *aNumSearchTerms = m_termList.Length();
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchSession::GetNthSearchTerm(int32_t whichTerm,
                                     nsMsgSearchAttribValue attrib,
                                     nsMsgSearchOpValue op,
                                     nsIMsgSearchValue* value) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsMsgSearchSession::CountSearchScopes(int32_t* _retval) {
  NS_ENSURE_ARG_POINTER(_retval);
  *_retval = m_scopeList.Length();
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchSession::GetNthSearchScope(int32_t which,
                                      nsMsgSearchScopeValue* scopeId,
                                      nsIMsgFolder** folder) {
  NS_ENSURE_ARG_POINTER(scopeId);
  NS_ENSURE_ARG_POINTER(folder);

  nsMsgSearchScopeTerm* scopeTerm = m_scopeList.SafeElementAt(which, nullptr);
  NS_ENSURE_ARG(scopeTerm);

  *scopeId = scopeTerm->m_attribute;
  NS_IF_ADDREF(*folder = scopeTerm->m_folder);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchSession::AddScopeTerm(nsMsgSearchScopeValue scope,
                                 nsIMsgFolder* folder) {
  if (scope != nsMsgSearchScope::allSearchableGroups) {
    NS_ASSERTION(folder, "need folder if not searching all groups");
    NS_ENSURE_TRUE(folder, NS_ERROR_NULL_POINTER);
  }

  nsMsgSearchScopeTerm* pScopeTerm =
      new nsMsgSearchScopeTerm(this, scope, folder);
  NS_ENSURE_TRUE(pScopeTerm, NS_ERROR_OUT_OF_MEMORY);

  m_scopeList.AppendElement(pScopeTerm);
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchSession::AddDirectoryScopeTerm(nsMsgSearchScopeValue scope) {
  nsMsgSearchScopeTerm* pScopeTerm =
      new nsMsgSearchScopeTerm(this, scope, nullptr);
  NS_ENSURE_TRUE(pScopeTerm, NS_ERROR_OUT_OF_MEMORY);

  m_scopeList.AppendElement(pScopeTerm);
  return NS_OK;
}

NS_IMETHODIMP nsMsgSearchSession::ClearScopes() {
  DestroyScopeList();
  return NS_OK;
}

NS_IMETHODIMP
nsMsgSearchSession::ScopeUsesCustomHeaders(nsMsgSearchScopeValue scope,
                                           void* selection, bool forFilters,
                                           bool* _retval) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP
nsMsgSearchSession::IsStringAttribute(nsMsgSearchAttribValue attrib,
                                      bool* _retval) {
  // Is this check needed?
  NS_ENSURE_ARG(_retval);
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP
nsMsgSearchSession::AddAllScopes(nsMsgSearchScopeValue attrib) {
  // don't think this is needed.
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsMsgSearchSession::Search(nsIMsgWindow* aWindow) {
  nsresult rv = Initialize();
  NS_ENSURE_SUCCESS(rv, rv);

  nsCOMPtr<nsIMsgSearchNotify> listener;
  m_iListener = 0;
  while (m_iListener != -1 && m_iListener < (signed)m_listenerList.Length()) {
    listener = m_listenerList[m_iListener];
    int32_t listenerFlags = m_listenerFlagList[m_iListener++];
    if (!listenerFlags || (listenerFlags & nsIMsgSearchSession::onNewSearch))
      listener->OnNewSearch();
  }
  m_iListener = -1;

  m_msgWindowWeak = do_GetWeakReference(aWindow);

  return BeginSearching();
}

NS_IMETHODIMP nsMsgSearchSession::InterruptSearch() {
  nsCOMPtr<nsIMsgWindow> msgWindow(do_QueryReferent(m_msgWindowWeak));
  if (msgWindow) {
    EnableFolderNotifications(true);

    while (m_idxRunningScope < m_scopeList.Length()) {
      ReleaseFolderDBRef();
      m_idxRunningScope++;
    }
    // m_idxRunningScope = m_scopeList.Length() so it will make us not run
    // another url
  }
  if (m_backgroundTimer) {
    m_backgroundTimer->Cancel();
    m_backgroundTimer = nullptr;
    NotifyListenersDone(NS_MSG_SEARCH_INTERRUPTED);
  }
  m_searchRunning = false;
  return NS_OK;
}

NS_IMETHODIMP nsMsgSearchSession::PauseSearch() {
  if (m_backgroundTimer) {
    m_backgroundTimer->Cancel();
    m_searchPaused = true;
    return NS_OK;
  } else
    return NS_ERROR_FAILURE;
}

NS_IMETHODIMP nsMsgSearchSession::ResumeSearch() {
  if (m_searchPaused) {
    m_searchPaused = false;
    return StartTimer();
  } else
    return NS_ERROR_FAILURE;
}

NS_IMETHODIMP nsMsgSearchSession::GetNumResults(int32_t* aNumResults) {
  return NS_ERROR_NOT_IMPLEMENTED;
}

NS_IMETHODIMP nsMsgSearchSession::SetWindow(nsIMsgWindow* aWindow) {
  m_msgWindowWeak = do_GetWeakReference(aWindow);
  return NS_OK;
}

NS_IMETHODIMP nsMsgSearchSession::GetWindow(nsIMsgWindow** aWindow) {
  NS_ENSURE_ARG_POINTER(aWindow);
  *aWindow = nullptr;
  nsCOMPtr<nsIMsgWindow> msgWindow(do_QueryReferent(m_msgWindowWeak));
  msgWindow.forget(aWindow);
  return NS_OK;
}

NS_IMETHODIMP nsMsgSearchSession::OnStartRunningUrl(nsIURI* url) {
  return NS_OK;
}

NS_IMETHODIMP nsMsgSearchSession::OnStopRunningUrl(nsIURI* url,
                                                   nsresult aExitCode) {
  nsCOMPtr<nsIMsgSearchAdapter> runningAdapter;

  nsresult rv = GetRunningAdapter(getter_AddRefs(runningAdapter));
  // tell the current adapter that the current url has run.
  if (NS_SUCCEEDED(rv) && runningAdapter) {
    runningAdapter->CurrentUrlDone(aExitCode);
    EnableFolderNotifications(true);
    ReleaseFolderDBRef();
  }
  if (++m_idxRunningScope < m_scopeList.Length())
    DoNextSearch();
  else
    NotifyListenersDone(aExitCode);
  return NS_OK;
}

nsresult nsMsgSearchSession::Initialize() {
  // Loop over scope terms, initializing an adapter per term. This
  // architecture is necessitated by two things:
  // 1. There might be more than one kind of adapter per if online
  //    *and* offline mail mail folders are selected, or if newsgroups
  //    belonging to Dredd *and* INN are selected
  // 2. Most of the protocols are only capable of searching one scope at a
  //    time, so we'll do each scope in a separate adapter on the client

  nsMsgSearchScopeTerm* scopeTerm = nullptr;
  nsresult rv = NS_OK;

  uint32_t numTerms = m_termList.Length();
  // Ensure that the FE has added scopes and terms to this search
  NS_ASSERTION(numTerms > 0, "no terms to search!");
  if (numTerms == 0) return NS_MSG_ERROR_NO_SEARCH_VALUES;

  // if we don't have any search scopes to search, return that code.
  if (m_scopeList.Length() == 0) return NS_MSG_ERROR_INVALID_SEARCH_SCOPE;

  m_runningUrl.Truncate();  // clear out old url, if any.
  m_idxRunningScope = 0;

  // If this term list (loosely specified here by the first term) should be
  // scheduled in parallel, build up a list of scopes to do the round-robin
  // scheduling
  for (uint32_t i = 0; i < m_scopeList.Length() && NS_SUCCEEDED(rv); i++) {
    scopeTerm = m_scopeList.ElementAt(i);
    // NS_ASSERTION(scopeTerm->IsValid());

    rv = scopeTerm->InitializeAdapter(m_termList);
  }
  m_searchRunning = true;

  return rv;
}

nsresult nsMsgSearchSession::BeginSearching() {
  // Here's a sloppy way to start the URL, but I don't really have time to
  // unify the scheduling mechanisms. If the first scope is a newsgroup, and
  // it's not Dredd-capable, we build the URL queue. All other searches can be
  // done with one URL
  m_searchRunning = true;
  return DoNextSearch();
}

nsresult nsMsgSearchSession::DoNextSearch() {
  nsMsgSearchScopeTerm* scope = m_scopeList.ElementAt(m_idxRunningScope);
  if (scope->m_attribute == nsMsgSearchScope::onlineMail ||
      (scope->m_attribute == nsMsgSearchScope::news && scope->m_searchServer)) {
    if (scope->m_adapter) {
      m_runningUrl.Truncate();
      scope->m_adapter->GetEncoding(getter_Copies(m_runningUrl));
    }
    NS_ENSURE_STATE(!m_runningUrl.IsEmpty());
    return GetNextUrl();
  }
  return SearchWOUrls();
}

nsresult nsMsgSearchSession::GetNextUrl() {
  if (!m_searchRunning) {
    return NS_OK;
  }

  nsMsgSearchScopeTerm* currentTerm = GetRunningScope();
  NS_ENSURE_TRUE(currentTerm, NS_ERROR_NULL_POINTER);
  EnableFolderNotifications(false);
  nsCOMPtr<nsIMsgFolder> folder = currentTerm->m_folder;
  if (folder) {
    nsCString folderUri;
    folder->GetURI(folderUri);
    nsCOMPtr<nsIMsgMessageService> msgService;
    nsresult rv =
        GetMessageServiceFromURI(folderUri, getter_AddRefs(msgService));

    nsCOMPtr<nsIMsgWindow> msgWindow(do_QueryReferent(m_msgWindowWeak));
    if (NS_SUCCEEDED(rv) && msgService && currentTerm)
      msgService->Search(this, msgWindow, currentTerm->m_folder, m_runningUrl);
    return rv;
  }
  return NS_OK;
}

/* static */
void nsMsgSearchSession::TimerCallback(nsITimer* aTimer, void* aClosure) {
  NS_ENSURE_TRUE_VOID(aClosure);
  nsMsgSearchSession* searchSession = (nsMsgSearchSession*)aClosure;

  bool isShuttingDown = false;
  nsCOMPtr<nsIAppStartup> appStartup(
      mozilla::components::AppStartup::Service());
  appStartup->GetShuttingDown(&isShuttingDown);
  if (isShuttingDown) {
    // Shutting down? Stop searching.
    searchSession->InterruptSearch();
    return;
  }

  bool done = false;
  searchSession->TimeSlice(&done);

  if (done) {
    if (aTimer) aTimer->Cancel();
    searchSession->m_backgroundTimer = nullptr;
    if (searchSession->m_idxRunningScope < searchSession->m_scopeList.Length())
      searchSession->DoNextSearch();
    else
      searchSession->NotifyListenersDone(NS_OK);
  }
}

nsresult nsMsgSearchSession::StartTimer() {
  nsresult rv;

  m_backgroundTimer = do_CreateInstance("@mozilla.org/timer;1", &rv);
  NS_ENSURE_SUCCESS(rv, rv);
  m_backgroundTimer->InitWithNamedFuncCallback(
      TimerCallback, (void*)this, 0, nsITimer::TYPE_REPEATING_SLACK,
      "nsMsgSearchSession::TimerCallback");
  TimerCallback(m_backgroundTimer, this);
  return NS_OK;
}

nsresult nsMsgSearchSession::SearchWOUrls() {
  EnableFolderNotifications(false);
  return StartTimer();
}

NS_IMETHODIMP
nsMsgSearchSession::GetRunningAdapter(nsIMsgSearchAdapter** aSearchAdapter) {
  NS_ENSURE_ARG_POINTER(aSearchAdapter);
  *aSearchAdapter = nullptr;
  nsMsgSearchScopeTerm* scope = GetRunningScope();
  if (scope) {
    NS_IF_ADDREF(*aSearchAdapter = scope->m_adapter);
  }
  return NS_OK;
}

NS_IMETHODIMP nsMsgSearchSession::AddSearchHit(nsIMsgDBHdr* aHeader,
                                               nsIMsgFolder* aFolder) {
  nsCOMPtr<nsIMsgSearchNotify> listener;
  m_iListener = 0;
  while (m_iListener != -1 && m_iListener < (signed)m_listenerList.Length()) {
    listener = m_listenerList[m_iListener];
    int32_t listenerFlags = m_listenerFlagList[m_iListener++];
    if (!listenerFlags || (listenerFlags & nsIMsgSearchSession::onSearchHit))
      listener->OnSearchHit(aHeader, aFolder);
  }
  m_iListener = -1;
  return NS_OK;
}

nsresult nsMsgSearchSession::NotifyListenersDone(nsresult aStatus) {
  // need to stabilize "this" in case one of the listeners releases the last
  // reference to us.
  RefPtr<nsIMsgSearchSession> kungFuDeathGrip(this);

  nsCOMPtr<nsIMsgSearchNotify> listener;
  m_iListener = 0;
  while (m_iListener != -1 && m_iListener < (signed)m_listenerList.Length()) {
    listener = m_listenerList[m_iListener];
    int32_t listenerFlags = m_listenerFlagList[m_iListener++];
    if (!listenerFlags || (listenerFlags & nsIMsgSearchSession::onSearchDone))
      listener->OnSearchDone(aStatus);
  }
  m_iListener = -1;
  m_searchRunning = false;
  return NS_OK;
}

void nsMsgSearchSession::DestroyScopeList() {
  nsMsgSearchScopeTerm* scope = nullptr;

  for (int32_t i = m_scopeList.Length() - 1; i >= 0; i--) {
    scope = m_scopeList.ElementAt(i);
    //    NS_ASSERTION (scope->IsValid(), "invalid search scope");
    if (scope->m_adapter) scope->m_adapter->ClearScope();
  }
  m_scopeList.Clear();
}

void nsMsgSearchSession::DestroyTermList() { m_termList.Clear(); }

nsMsgSearchScopeTerm* nsMsgSearchSession::GetRunningScope() {
  return m_scopeList.SafeElementAt(m_idxRunningScope, nullptr);
}

nsresult nsMsgSearchSession::TimeSlice(bool* aDone) {
  // we only do serial for now.
  return TimeSliceSerial(aDone);
}

void nsMsgSearchSession::ReleaseFolderDBRef() {
  nsMsgSearchScopeTerm* scope = GetRunningScope();
  if (!scope) return;

  bool isOpen = false;
  uint32_t flags;
  nsCOMPtr<nsIMsgFolder> folder;
  scope->GetFolder(getter_AddRefs(folder));
  if (!folder) return;

  folder->GetDatabaseOpen(&isOpen);
  folder->GetFlags(&flags);

  /*we don't null out the db reference for inbox because inbox is like the
    "main" folder and performance outweighs footprint */
  if (!isOpen && !(nsMsgFolderFlags::Inbox & flags))
    folder->SetMsgDatabase(nullptr);
}
nsresult nsMsgSearchSession::TimeSliceSerial(bool* aDone) {
  // This version of TimeSlice runs each scope term one at a time, and waits
  // until one scope term is finished before starting another one. When we're
  // searching the local disk, this is the fastest way to do it.

  NS_ENSURE_ARG_POINTER(aDone);

  nsMsgSearchScopeTerm* scope = GetRunningScope();
  if (!scope) {
    *aDone = true;
    return NS_OK;
  }

  nsresult rv = scope->TimeSlice(aDone);
  if (*aDone || NS_FAILED(rv)) {
    EnableFolderNotifications(true);
    ReleaseFolderDBRef();
    m_idxRunningScope++;
    EnableFolderNotifications(false);
    // check if the next scope is an online search; if so,
    // set *aDone to true so that we'll try to run the next
    // search in TimerCallback.
    scope = GetRunningScope();
    if (scope && (scope->m_attribute == nsMsgSearchScope::onlineMail ||
                  (scope->m_attribute == nsMsgSearchScope::news &&
                   scope->m_searchServer))) {
      *aDone = true;
      return rv;
    }
  }
  *aDone = false;
  return rv;
}

void nsMsgSearchSession::EnableFolderNotifications(bool aEnable) {
  nsMsgSearchScopeTerm* scope = GetRunningScope();
  if (scope) {
    nsCOMPtr<nsIMsgFolder> folder;
    scope->GetFolder(getter_AddRefs(folder));
    if (folder)  // enable msg count notifications
      folder->EnableNotifications(nsIMsgFolder::allMessageCountNotifications,
                                  aEnable);
  }
}

// this method is used for adding new hdrs to quick search view
NS_IMETHODIMP
nsMsgSearchSession::MatchHdr(nsIMsgDBHdr* aMsgHdr, nsIMsgDatabase* aDatabase,
                             bool* aResult) {
  nsMsgSearchScopeTerm* scope = m_scopeList.SafeElementAt(0, nullptr);
  if (scope) {
    if (!scope->m_adapter) scope->InitializeAdapter(m_termList);
    if (scope->m_adapter) {
      nsAutoString folderCharset;
      scope->m_adapter->GetSearchCharset(folderCharset);
      NS_ConvertUTF16toUTF8 charset(folderCharset.get());
      nsMsgSearchOfflineMail::MatchTermsForSearch(
          aMsgHdr, m_termList, charset.get(), scope, aDatabase,
          &m_expressionTree, aResult);
    }
  }
  return NS_OK;
}
