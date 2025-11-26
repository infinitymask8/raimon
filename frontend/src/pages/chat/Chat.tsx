import { useRef, useState, useEffect, useContext, useLayoutEffect } from 'react'
import { CommandBarButton, Dialog, DialogType, Stack } from '@fluentui/react'
import { SquareRegular } from '@fluentui/react-icons'

import uuid from 'react-uuid'
import { isEmpty } from 'lodash'

import styles from './Chat.module.css'
import logochat from '../../assets/logochat.svg' // Mantenemos tu logo actual

import {
  ChatMessage,
  ConversationRequest,
  conversationApi,
  Citation,
  ToolMessageContent,
  ChatResponse,
  getUserInfo,
  Conversation,
  historyGenerate,
  historyUpdate,
  historyClear,
  ChatHistoryLoadingState,
  CosmosDBStatus,
  ErrorMessage
} from "../../api";

import { Answer } from "../../components/Answer";
import { QuestionInput } from "../../components/QuestionInput";
import { AppStateContext } from "../../state/AppProvider";
import { useBoolean } from "@fluentui/react-hooks";

const enum messageStatus {
  NotRunning = 'Not Running',
  Processing = 'Processing',
  Done = 'Done'
}

const Chat = () => {
  const appStateContext = useContext(AppStateContext)
  const ui = appStateContext?.state.frontendSettings?.ui
  const AUTH_ENABLED = appStateContext?.state.frontendSettings?.auth_enabled
  const chatMessageStreamEnd = useRef<HTMLDivElement | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [showLoadingMessage, setShowLoadingMessage] = useState<boolean>(false)
  const [activeCitation, setActiveCitation] = useState<Citation>()
  const [isCitationPanelOpen, setIsCitationPanelOpen] = useState<boolean>(false)
  const abortFuncs = useRef([] as AbortController[])
  const [showAuthMessage, setShowAuthMessage] = useState<boolean | undefined>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [processMessages, setProcessMessages] = useState<messageStatus>(messageStatus.NotRunning)
  const [clearingChat, setClearingChat] = useState<boolean>(false)
  const [hideErrorDialog, { toggle: toggleErrorDialog }] = useBoolean(true)
  const [errorMsg, setErrorMsg] = useState<ErrorMessage | null>()
  const [logo, setLogo] = useState('')

  const errorDialogContentProps = {
    type: DialogType.close,
    title: errorMsg?.title,
    closeButtonAriaLabel: 'Close',
    subText: errorMsg?.subtitle
  }

  const modalProps = {
    titleAriaId: 'labelId',
    subtitleAriaId: 'subTextId',
    isBlocking: true,
    styles: { main: { maxWidth: 450 } }
  }

  const [ASSISTANT, TOOL, ERROR] = ['assistant', 'tool', 'error']

  useEffect(() => {
    if (
      appStateContext?.state.isCosmosDBAvailable?.status !== CosmosDBStatus.Working &&
      appStateContext?.state.isCosmosDBAvailable?.status !== CosmosDBStatus.NotConfigured &&
      appStateContext?.state.chatHistoryLoadingState === ChatHistoryLoadingState.Fail &&
      hideErrorDialog
    ) {
      let subtitle = `${appStateContext.state.isCosmosDBAvailable.status}. Please contact the site administrator.`
      setErrorMsg({
        title: 'Chat history is not enabled',
        subtitle: subtitle
      })
      toggleErrorDialog()
    }
  }, [appStateContext?.state.isCosmosDBAvailable])

  const handleErrorDialogClose = () => {
    toggleErrorDialog()
    setTimeout(() => {
      setErrorMsg(null)
    }, 500)
  }

  // Configuración del Logo
  useEffect(() => {
    if (!appStateContext?.state.isLoading) {
      setLogo(ui?.chat_logo || ui?.logo || logochat)
    }
  }, [appStateContext?.state.isLoading])

  useEffect(() => {
    setIsLoading(appStateContext?.state.chatHistoryLoadingState === ChatHistoryLoadingState.Loading)
  }, [appStateContext?.state.chatHistoryLoadingState])

  const getUserInfoList = async () => {
    if (!AUTH_ENABLED) {
      setShowAuthMessage(false)
      return
    }
    const userInfoList = await getUserInfo()
    if (userInfoList.length === 0 && window.location.hostname !== '127.0.0.1') {
      setShowAuthMessage(true)
    } else {
      setShowAuthMessage(false)
    }
  }

  let assistantMessage = {} as ChatMessage
  let toolMessage = {} as ChatMessage
  let assistantContent = ''

  const processResultMessage = (resultMessage: ChatMessage, userMessage: ChatMessage, conversationId?: string) => {
    if (resultMessage.role === ASSISTANT) {
      assistantContent += resultMessage.content
      assistantMessage = { ...assistantMessage, ...resultMessage }
      assistantMessage.content = assistantContent

      if (resultMessage.context) {
        toolMessage = {
          id: uuid(),
          role: TOOL,
          content: resultMessage.context,
          date: new Date().toISOString()
        }
      }
    }

    if (resultMessage.role === TOOL) toolMessage = resultMessage

    if (!conversationId) {
      isEmpty(toolMessage)
        ? setMessages([...messages, userMessage, assistantMessage])
        : setMessages([...messages, userMessage, toolMessage, assistantMessage])
    } else {
      isEmpty(toolMessage)
        ? setMessages([...messages, assistantMessage])
        : setMessages([...messages, toolMessage, assistantMessage])
    }
  }

  const makeApiRequestWithoutCosmosDB = async (question: string, conversationId?: string) => {
    setIsLoading(true)
    setShowLoadingMessage(true)
    const abortController = new AbortController()
    abortFuncs.current.unshift(abortController)

    const userMessage: ChatMessage = {
      id: uuid(),
      role: 'user',
      content: question,
      date: new Date().toISOString()
    }

    let conversation: Conversation | null | undefined
    if (!conversationId) {
      conversation = {
        id: conversationId ?? uuid(),
        title: question,
        messages: [userMessage],
        date: new Date().toISOString()
      }
    } else {
      conversation = appStateContext?.state?.currentChat
      if (!conversation) {
        console.error('Conversation not found.')
        setIsLoading(false)
        setShowLoadingMessage(false)
        abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
        return
      } else {
        conversation.messages.push(userMessage)
      }
    }

    appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: conversation })
    setMessages(conversation.messages)

    const request: ConversationRequest = {
      messages: [...conversation.messages.filter(answer => answer.role !== ERROR)]
    }

    let result = {} as ChatResponse
    try {
      const response = await conversationApi(request, abortController.signal)
      if (response?.body) {
        const reader = response.body.getReader()
        let runningText = ''
        while (true) {
          setProcessMessages(messageStatus.Processing)
          const { done, value } = await reader.read()
          if (done) break
          var text = new TextDecoder('utf-8').decode(value)
          const objects = text.split('\n')
          objects.forEach(obj => {
            try {
              if (obj !== '' && obj !== '{}') {
                runningText += obj
                result = JSON.parse(runningText)
                if (result.choices?.length > 0) {
                  result.choices[0].messages.forEach(msg => {
                    msg.id = result.id
                    msg.date = new Date().toISOString()
                  })
                  if (result.choices[0].messages?.some(m => m.role === ASSISTANT)) {
                    setShowLoadingMessage(false)
                  }
                  result.choices[0].messages.forEach(resultObj => {
                    processResultMessage(resultObj, userMessage, conversationId)
                  })
                } else if (result.error) {
                  throw Error(result.error)
                }
                runningText = ''
              }
            } catch (e) {
              if (!(e instanceof SyntaxError)) {
                console.error(e)
                throw e
              }
            }
          })
        }
        conversation.messages.push(toolMessage, assistantMessage)
        appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: conversation })
        setMessages([...messages, toolMessage, assistantMessage])
      }
    } catch (e) {
      if (!abortController.signal.aborted) {
        let errorMessage = 'An error occurred. Please try again.'
        if (result.error?.message) {
          errorMessage = result.error.message
        } else if (typeof result.error === 'string') {
          errorMessage = result.error
        }
        let errorChatMsg: ChatMessage = {
          id: uuid(),
          role: ERROR,
          content: errorMessage,
          date: new Date().toISOString()
        }
        conversation.messages.push(errorChatMsg)
        appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: conversation })
        setMessages([...messages, errorChatMsg])
      } else {
        setMessages([...messages, userMessage])
      }
    } finally {
      setIsLoading(false)
      setShowLoadingMessage(false)
      abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
      setProcessMessages(messageStatus.Done)
    }
    return abortController.abort()
  }

  const makeApiRequestWithCosmosDB = async (question: string, conversationId?: string) => {
    setIsLoading(true)
    setShowLoadingMessage(true)
    const abortController = new AbortController()
    abortFuncs.current.unshift(abortController)

    const userMessage: ChatMessage = {
      id: uuid(),
      role: 'user',
      content: question,
      date: new Date().toISOString()
    }

    let conversation: Conversation | null | undefined
    if (!conversationId) {
      conversation = {
        id: conversationId ?? uuid(),
        title: question,
        messages: [userMessage],
        date: new Date().toISOString()
      }
    } else {
      conversation = appStateContext?.state?.currentChat
      if (!conversation) {
        console.error('Conversation not found.')
        setIsLoading(false)
        setShowLoadingMessage(false)
        abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
        return
      } else {
        conversation.messages.push(userMessage)
      }
    }

    appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: conversation })
    setMessages(conversation.messages)

    const request: ConversationRequest = {
      messages: [...conversation.messages.filter(answer => answer.role !== ERROR)]
    }

    let result = {} as ChatResponse
    try {
      const response = await historyGenerate(request, abortController.signal, conversationId)
      if (!response?.ok) {
        const responseJson = await response.json()
        var errorResponseMessage = responseJson.error === undefined ? "Please try again. If the problem persists, please contact the site administrator." : responseJson.error
        throw Error(errorResponseMessage)
      }
      if (response?.body) {
        const reader = response.body.getReader()
        let runningText = ''
        while (true) {
          setProcessMessages(messageStatus.Processing)
          const { done, value } = await reader.read()
          if (done) break
          var text = new TextDecoder('utf-8').decode(value)
          const objects = text.split('\n')
          objects.forEach(obj => {
            try {
              if (obj !== '' && obj !== '{}') {
                runningText += obj
                result = JSON.parse(runningText)
                if (result.choices?.length > 0) {
                  result.choices[0].messages.forEach(msg => {
                    msg.id = result.id
                    msg.date = new Date().toISOString()
                  })
                  if (result.choices[0].messages?.some(m => m.role === ASSISTANT)) {
                    setShowLoadingMessage(false)
                  }
                  result.choices[0].messages.forEach(resultObj => {
                    processResultMessage(resultObj, userMessage, conversationId)
                  })
                }
                runningText = ''
              }
            } catch (e) {
              if (!(e instanceof SyntaxError)) {
                console.error(e)
                throw e
              }
            }
          })
        }

        let resultConversation = {
          id: conversationId ? conversationId : result.history_metadata.conversation_id,
          title: conversationId ? conversation.title : result.history_metadata.title,
          messages: [userMessage],
          date: conversation.date
        }
        if (!isEmpty(toolMessage)) resultConversation.messages.push(toolMessage)
        if (!isEmpty(assistantMessage)) resultConversation.messages.push(assistantMessage)
        
        // CORRECCIÓN 1: Pasamos los argumentos separados como pide tu api.ts
        await historyUpdate(resultConversation.messages, resultConversation.id)

        conversation.messages.push(toolMessage, assistantMessage)
        appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: conversation })
        setMessages([...messages, toolMessage, assistantMessage])
      }
    } catch (e) {
      if (!abortController.signal.aborted) {
        let errorMessage = 'An error occurred. Please try again.'
        if (result.error?.message) {
          errorMessage = result.error.message
        } else if (typeof result.error === 'string') {
          errorMessage = result.error
        }
        let errorChatMsg: ChatMessage = {
          id: uuid(),
          role: ERROR,
          content: errorMessage,
          date: new Date().toISOString()
        }
        conversation.messages.push(errorChatMsg)
        appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: conversation })
        setMessages([...messages, errorChatMsg])
      } else {
        setMessages([...messages, userMessage])
      }
    } finally {
      setIsLoading(false)
      setShowLoadingMessage(false)
      abortFuncs.current = abortFuncs.current.filter(a => a !== abortController)
      setProcessMessages(messageStatus.Done)
    }
    return abortController.abort()
  }

  const clearChat = async () => {
    setClearingChat(true)
    if (appStateContext?.state.currentChat?.id && appStateContext?.state.isCosmosDBAvailable.cosmosDB) {
      let response = await historyClear(appStateContext?.state.currentChat.id)
      if (!response.ok) {
        setErrorMsg({
          title: 'Error clearing current chat',
          subtitle: 'Please try again.'
        })
        toggleErrorDialog()
      } else {
        appStateContext?.dispatch({
          type: 'DELETE_CURRENT_CHAT_MESSAGES',
          payload: appStateContext?.state.currentChat.id
        })
        appStateContext?.dispatch({ type: 'UPDATE_CHAT_HISTORY', payload: appStateContext?.state.currentChat })
        setActiveCitation(undefined)
        setIsCitationPanelOpen(false)
        setMessages([])
      }
    }
    setClearingChat(false)
  }

  const newChat = () => {
    setProcessMessages(messageStatus.Processing)
    setMessages([])
    setIsCitationPanelOpen(false)
    setActiveCitation(undefined)
    appStateContext?.dispatch({ type: 'UPDATE_CURRENT_CHAT', payload: null })
    setProcessMessages(messageStatus.Done)
  }

  const stopGenerating = () => {
    abortFuncs.current.forEach(a => a.abort())
    setShowLoadingMessage(false)
    setIsLoading(false)
  }

  useEffect(() => {
    if (appStateContext?.state.currentChat) {
      setMessages(appStateContext.state.currentChat.messages)
    } else {
      setMessages([])
    }
  }, [appStateContext?.state.currentChat])

  useLayoutEffect(() => {
    chatMessageStreamEnd.current?.scrollIntoView({ behavior: 'smooth' })
  }, [showLoadingMessage, processMessages])

  const onShowCitation = (citation: Citation) => {
    setActiveCitation(citation)
    setIsCitationPanelOpen(true)
  }

  const parseCitationFromMessage = (message: ChatMessage) => {
    if (message?.role && message?.role === 'tool' && typeof message?.content === "string") {
      try {
        const toolMessage = JSON.parse(message.content) as ToolMessageContent
        return toolMessage.citations
      } catch {
        return []
      }
    }
    return []
  }

  return (
    <div className={styles.container} role="main">
      <Stack horizontal className={styles.chatRoot}>
        <div className={styles.chatContainer}>
          {!messages || messages.length < 1 ? (
            <Stack className={styles.chatEmptyState}>
              <img src={logo} className={styles.chatIcon} aria-hidden="true" alt="Logo" />
              <h1 className={styles.chatEmptyStateTitle}>Bienvenido a Güntner AI</h1>
              <h2 className={styles.chatEmptyStateSubtitle}>Tu asistente virtual experto en ingeniería y productos Güntner</h2>
            </Stack>
          ) : (
            <div className={styles.chatMessageStream} style={{ marginBottom: isLoading ? '40px' : '0px' }} role="log">
              {messages.map((answer, index) => (
                <div key={index}>
                  {answer.role === 'user' ? (
                    <div className={styles.chatMessageUser} tabIndex={0}>
                      <div className={styles.chatMessageUserMessage}>
                        {typeof answer.content === "string" ? answer.content : "User sent an image"}
                      </div>
                    </div>
                  ) : answer.role === 'assistant' ? (
                    <div className={styles.chatMessageGpt}>
                      <Answer
                        answer={{
                          answer: typeof answer.content === "string" ? answer.content : "",
                          citations: parseCitationFromMessage(messages[index - 1]),
                          message_id: answer.id,
                          feedback: answer.feedback,
                          generated_chart: null // Satisfacemos TypeScript
                        }}
                        onCitationClicked={c => onShowCitation(c)}
                        // CORRECCIÓN 2: Agregamos la función obligatoria (vacía para que no falle)
                        onExectResultClicked={() => null}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
              {showLoadingMessage && (
                <div className={styles.chatMessageGpt}>
                  <Answer
                    answer={{
                      answer: "Generando respuesta...",
                      citations: [],
                      generated_chart: null
                    }}
                    onCitationClicked={() => null}
                    // CORRECCIÓN 3: Agregamos la función obligatoria aquí también
                    onExectResultClicked={() => null}
                  />
                </div>
              )}
              <div ref={chatMessageStreamEnd} />
            </div>
          )}

          <Stack horizontal className={styles.chatInput}>
            {isLoading && messages.length > 0 && (
              <Stack
                horizontal
                className={styles.stopGeneratingContainer}
                role="button"
                aria-label="Stop generating"
                tabIndex={0}
                onClick={stopGenerating}
                onKeyDown={e => (e.key === 'Enter' || e.key === ' ' ? stopGenerating() : null)}>
                <SquareRegular className={styles.stopGeneratingIcon} aria-hidden="true" />
                <span className={styles.stopGeneratingText} aria-hidden="true">
                    Detener
                  </span>
              </Stack>
            )}
            <Stack>
              <CommandBarButton
                role="button"
                styles={{
                  root: { color: '#FFFFFF', background: '#003056' }
                }}
                className={styles.newChatIcon}
                iconProps={{ iconName: 'Add' }}
                onClick={newChat}
                aria-label="Nuevo chat"
                text="Nuevo chat"
              />
              <CommandBarButton
                role="button"
                styles={{
                  root: { color: '#FFFFFF', background: '#003056' }
                }}
                className={appStateContext?.state.isCosmosDBAvailable?.status !== CosmosDBStatus.NotConfigured ? styles.clearChatBroom : styles.clearChatBroomNoCosmos}
                iconProps={{ iconName: 'Broom' }}
                onClick={clearChat}
                aria-label="Limpiar chat"
                text="Limpiar chat"
              />
              <Dialog
                hidden={hideErrorDialog}
                onDismiss={handleErrorDialogClose}
                dialogContentProps={errorDialogContentProps}
                modalProps={modalProps}></Dialog>
            </Stack>
            <QuestionInput
              clearOnSend
              placeholder="Escribe tu pregunta aquí..."
              disabled={isLoading}
              onSend={(question, id) => {
                if (appStateContext?.state.isCosmosDBAvailable?.status === CosmosDBStatus.Working) {
                    if(typeof question === 'string'){
                        makeApiRequestWithCosmosDB(question, id)
                    } else {
                        const text = question[0]?.text || "";
                        makeApiRequestWithCosmosDB(text, id);
                    }
                } else {
                    if(typeof question === 'string'){
                        makeApiRequestWithoutCosmosDB(question, id)
                    } else {
                        const text = question[0]?.text || "";
                        makeApiRequestWithoutCosmosDB(text, id);
                    }
                }
              }}
              conversationId={appStateContext?.state.currentChat?.id}
            />
          </Stack>
        </div>
      </Stack>
    </div>
  )
}

export default Chat