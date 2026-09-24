#import <Foundation/Foundation.h>
#import <objc/runtime.h>

// A frame socket with no network. Swift cannot construct a URLSessionWebSocketTask subclass,
// so the tests reach these by name. A receive stays pending until the socket is cancelled,
// as a quiet real socket does, so Foundation's own async receive() wrapper runs unchanged.
@interface PathwayFakeFrameSocket : NSURLSessionWebSocketTask
@property(nonatomic, copy) void (^onReceive)(void);
@property(nonatomic, copy) void (^pendingReceive)(NSURLSessionWebSocketMessage *, NSError *);
@property(nonatomic) NSInteger cancelCount;
@end

@implementation PathwayFakeFrameSocket
- (void)resume {}
- (void)receiveMessageWithCompletionHandler:(void (^)(NSURLSessionWebSocketMessage *, NSError *))completion {
    self.pendingReceive = completion;
    void (^ready)(void) = self.onReceive;
    self.onReceive = nil;
    if (ready) ready();
}
- (void)cancelWithCloseCode:(NSURLSessionWebSocketCloseCode)code reason:(NSData *)reason {
    self.cancelCount += 1;
    void (^pending)(NSURLSessionWebSocketMessage *, NSError *) = self.pendingReceive;
    self.pendingReceive = nil;
    if (pending) pending(nil, [NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorCancelled userInfo:nil]);
}
@end

@interface PathwayFakeFrameSession : NSURLSession
@property(nonatomic, strong) NSMutableArray<PathwayFakeFrameSocket *> *sockets;
/// Handed to the next socket, which calls it once its first receive is pending.
@property(nonatomic, copy) void (^onReceive)(void);
@end

@implementation PathwayFakeFrameSession
- (instancetype)init {
    if ((self = [super init])) self.sockets = [NSMutableArray array];
    return self;
}
- (NSURLSessionWebSocketTask *)webSocketTaskWithURL:(NSURL *)url {
    PathwayFakeFrameSocket *socket = class_createInstance([PathwayFakeFrameSocket class], 0);
    socket.onReceive = self.onReceive;
    self.onReceive = nil;
    [self.sockets addObject:socket];
    return socket;
}
@end
