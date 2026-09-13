package site.codexassistant

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

/** Application-wide ownership: a visible Activity and the foreground service share one socket. */
class SyncCoordinator(context: Context) {
    private val appContext=context.applicationContext
    private val connectivity=appContext.getSystemService(ConnectivityManager::class.java)
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
    private val mutableState=MutableStateFlow(TaskState())
    private val traceLogger=TraceLogger()
    private var job:Job?=null
    @Volatile private var repository:TaskRepository?=null
    private var visible=false
    private var hasBeenForeground=false
    private var service:Any?=null
    private var background="stopped"
    private var network:Network?=null
    private var callback:ConnectivityManager.NetworkCallback?=null
    fun state():StateFlow<TaskState> = mutableState.asStateFlow()

    @Synchronized fun foreground() {
        traceLogger.event("android.lifecycle.foreground")
        val returning=hasBeenForeground && !visible
        visible=true
        hasBeenForeground=true
        start()
        refreshNetwork(returning)
    }
    @Synchronized fun background(changingConfiguration:Boolean) {
        if(changingConfiguration) return
        traceLogger.event("android.lifecycle.background")
        visible=false
        stopIfUnowned()
    }
    @Synchronized fun serviceStarted(owner:Any) {
        traceLogger.event("android.service.started")
        service=owner;background="running"
        mutableState.value=mutableState.value.copy(backgroundSyncStatus=background)
        start()
    }
    @Synchronized fun serviceStopped(owner:Any,unavailable:Boolean=false) {
        if(service!==owner) return
        traceLogger.event("android.service.stopped")
        service=null;background=if(unavailable) "unavailable" else "stopped"
        mutableState.value=mutableState.value.copy(backgroundSyncStatus=background)
        stopIfUnowned()
    }
    @Synchronized fun serviceUnavailable() {
        if(service==null) { background="unavailable";mutableState.value=mutableState.value.copy(backgroundSyncStatus=background) }
    }
    fun ensureForegroundService() {
        if(CredentialStore(appContext).token()==null) return
        try { ContextCompat.startForegroundService(appContext,Intent(appContext,SyncForegroundService::class.java)) }
        catch(_:IllegalStateException) { serviceUnavailable() }
        catch(_:SecurityException) { serviceUnavailable() }
    }
    private fun refreshNetwork(foreground:Boolean=false) {
        val current=connectivity.activeNetwork
        updateNetwork(current,foreground)
    }
    private fun updateNetwork(next:Network?,foreground:Boolean=false) {
        val changed=network!=next
        network=next
        mutableState.value=mutableState.value.copy(networkAvailable=next!=null)
        repository?.recover(next!=null,foreground,changed)
    }
    private fun start() {
        if((!visible && service==null) || job?.isActive==true) return
        val credentials=CredentialStore(appContext)
        if(credentials.token()==null) {
            mutableState.value=mutableState.value.copy(connectionStatus="not_configured",error="请先配置访问 Token")
            return
        }
        if(callback==null) {
            val listener=object:ConnectivityManager.NetworkCallback() {
                override fun onAvailable(n:Network) { synchronized(this@SyncCoordinator) {
                    if(callback===this) updateNetwork(n)
                } }
                override fun onLost(n:Network) { synchronized(this@SyncCoordinator) {
                    if(callback===this && network==n) updateNetwork(null)
                } }
            }
            callback=listener
            connectivity.registerDefaultNetworkCallback(listener)
        }
        network=connectivity.activeNetwork
        val initial=mutableState.value.copy(cursor=credentials.cursor(),networkAvailable=network!=null,backgroundSyncStatus=background,connected=false)
        mutableState.value=initial
        val next=TaskRepository(credentials,initial)
        repository=next
        job=scope.launch {
            next.stream().collect { incoming -> synchronized(this@SyncCoordinator) {
                if(repository===next) mutableState.value=incoming.copy(backgroundSyncStatus=background,networkAvailable=network!=null)
            } }
        }
    }
    private fun stopIfUnowned() { if(!visible && service==null) stop() }
    private fun stop() {
        repository?.stop();repository=null
        job?.cancel();job=null
        callback?.let { connectivity.unregisterNetworkCallback(it) };callback=null
        mutableState.value=mutableState.value.copy(connected=false,connectionStatus="offline",retryAtEpochMs=null,error="同步服务已停止，打开应用后恢复",backgroundSyncStatus=background)
    }
    @Synchronized fun restart() {
        stop()
        mutableState.value=TaskState(cursor=CredentialStore(appContext).cursor(),backgroundSyncStatus=background)
        start()
    }
    fun requestDetail(threadId:String,cursor:String?=null):String = repository?.requestDetail(threadId,cursor) ?: error("连接不可用")
    fun sendMessage(threadId:String,text:String):String = repository?.sendMessage(threadId,text) ?: error("连接不可用")
    fun submitInteraction(requestId:String,threadId:String,value:kotlinx.serialization.json.JsonElement):Boolean = repository?.submitInteraction(requestId,threadId,value)==true
    @Synchronized fun refreshNow(): Boolean {
        traceLogger.event("android.refresh.manual")
        val active = repository ?: return false
        mutableState.value = mutableState.value.copy(isRefreshing = true, refreshError = null)
        val accepted = active.refreshNow()
        if (!accepted) mutableState.value = mutableState.value.copy(isRefreshing = false, refreshError = "同步尚未启动，请稍后重试")
        return accepted
    }
}
