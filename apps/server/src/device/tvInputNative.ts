/**
 * Compiled on the selected Mac during staged helper installation. Uses the same
 * private CoreSimulator lookup as serve-sim; DTUHID carries actual button events.
 * Protocol reference: facebook/idb FBSimulatorControl/HID/SimulatorDTUHIDConnection.swift.
 */
export const tvInputNativeSource = String.raw`
#import <Foundation/Foundation.h>
#import <xpc/xpc.h>
#import <dlfcn.h>

@interface NSObject (Simulator)
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (mach_port_t)lookup:(NSString *)service error:(NSError **)error;
@end

static const char *service = "com.apple.coredevice.feature.remote.hid.digitizer";
static xpc_object_t message(BOOL keyboard, uint64_t usage, uint64_t state, BOOL barrier) {
  xpc_object_t msg=xpc_dictionary_create(NULL,NULL,0), payload=xpc_dictionary_create(NULL,NULL,0);
  xpc_dictionary_set_string(msg,"messageType",keyboard?"IndigoKeyboardButtonEvent":"IndigoButtonEvent");
  xpc_dictionary_set_string(msg,"featureIdentifier",service);
  xpc_dictionary_set_bool(msg,"isBarrier",barrier);
  xpc_dictionary_set_uint64(payload,"usageCode",usage);
  xpc_dictionary_set_uint64(payload,"state",state);
  if(!keyboard) xpc_dictionary_set_uint64(payload,"usagePage",12);
  xpc_dictionary_set_value(msg,"payload",payload);
  return msg;
}
static BOOL barrier(xpc_connection_t conn) {
  dispatch_semaphore_t sem=dispatch_semaphore_create(0);
  __block BOOL ok=NO;
  xpc_connection_send_message_with_reply(conn,message(YES,0,2,YES),dispatch_get_global_queue(0,0),^(xpc_object_t response){ok=xpc_get_type(response)!=XPC_TYPE_ERROR;dispatch_semaphore_signal(sem);});
  return dispatch_semaphore_wait(sem,dispatch_time(DISPATCH_TIME_NOW,4*NSEC_PER_SEC))==0 && ok;
}
int main(int argc, const char **argv) { @autoreleasepool {
  if(argc!=2) return 2;
  NSString *developerDir=NSProcessInfo.processInfo.environment[@"DEVELOPER_DIR"];
  if(!developerDir.length) {
    NSTask *task=[NSTask new]; NSPipe *pipe=[NSPipe pipe];
    task.executableURL=[NSURL fileURLWithPath:@"/usr/bin/xcode-select"];
    task.arguments=@[@"-p"]; task.standardOutput=pipe;
    if(![task launchAndReturnError:nil]) return 2;
    developerDir=[[[NSString alloc] initWithData:[pipe.fileHandleForReading readDataToEndOfFile] encoding:NSUTF8StringEncoding] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    [task waitUntilExit]; if(task.terminationStatus!=0) return 2;
  }
  dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",RTLD_NOW);
  NSError *err=nil;
  id context=[NSClassFromString(@"SimServiceContext") sharedServiceContextForDeveloperDir:developerDir error:&err];
  id set=[context defaultDeviceSetWithError:&err], device=nil;
  for(id d in [set valueForKey:@"devices"]) if([[[d valueForKey:@"UDID"] UUIDString] caseInsensitiveCompare:@(argv[1])]==NSOrderedSame) device=d;
  if(!device || ![[[device valueForKey:@"runtime"] valueForKey:@"identifier"] containsString:@".tvOS-"]) {
    fprintf(stderr,"A tvOS simulator is required\n");return 3;
  }
  mach_port_t port=[device lookup:@(service) error:&err];
  xpc_endpoint_t (*makeEndpoint)(mach_port_t,uint64_t,uint64_t)=dlsym(RTLD_DEFAULT,"xpc_endpoint_create_mach_port_4sim");
  void (*enable)(xpc_connection_t)=dlsym(RTLD_DEFAULT,"xpc_connection_enable_sim2host_4sim");
  if(!port||!makeEndpoint||!enable) {fprintf(stderr,"DTUHID unavailable: %s\n",err.description.UTF8String);return 4;}
  xpc_connection_t conn=xpc_connection_create_from_endpoint(makeEndpoint(port,0,0));
  if(!conn) {fprintf(stderr,"Cannot connect to DTUHID\n");return 4;}
  enable(conn);
  xpc_connection_set_event_handler(conn,^(xpc_object_t event){});
  xpc_connection_resume(conn);
  if(!barrier(conn)) {fprintf(stderr,"DTUHID liveness timeout\n");return 5;}
  // The liveness reply precedes dtuhidd opening its virtual devices. This warmup is
  // paid once per connection; presses below are sequenced by service barriers.
  usleep(200000);
  NSDictionary *buttons=@{@"up":@0x52,@"down":@0x51,@"left":@0x50,@"right":@0x4f,@"select":@0x28,@"menu":@0x29,@"back":@0x29,@"home":@0x40,@"playPause":@0xcd};
  char *line=NULL;size_t size=0;
  while(getline(&line,&size,stdin)>0) { @autoreleasepool {
    NSDictionary *input=[NSJSONSerialization JSONObjectWithData:[@(line) dataUsingEncoding:NSUTF8StringEncoding] options:0 error:&err];
    if(![input isKindOfClass:NSDictionary.class] || ![input[@"id"] isKindOfClass:NSString.class] || ![input[@"button"] isKindOfClass:NSString.class]) {
      fprintf(stderr,"Invalid TV input request\n");return 6;
    }
    NSString *button=input[@"button"]; NSNumber *usage=buttons[button];
    BOOL ok=usage!=nil;
    if(ok) {
      BOOL keyboard=![button isEqualToString:@"home"]&&![button isEqualToString:@"playPause"];
      xpc_connection_send_message(conn,message(keyboard,usage.unsignedLongLongValue,1,NO));
      xpc_connection_send_message(conn,message(keyboard,usage.unsignedLongLongValue,2,NO));
      ok=barrier(conn);
    }
    NSData *json=[NSJSONSerialization dataWithJSONObject:@{@"id":input[@"id"]?:@"",@"ok":@(ok),@"error":ok?@"":@"TV HID service rejected the input or did not answer"} options:0 error:nil];
    puts([[NSString alloc]initWithData:json encoding:NSUTF8StringEncoding].UTF8String);fflush(stdout);
  }}
  free(line);usleep(80000);xpc_connection_cancel(conn);return 0;
}}
`;
