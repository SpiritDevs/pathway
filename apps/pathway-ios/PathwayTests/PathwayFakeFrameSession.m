#import <Foundation/Foundation.h>
#import <objc/runtime.h>

// A frame socket with no network. Swift cannot construct a URLSessionWebSocketTask subclass,
// so the tests reach these by name. A receive stays pending until the test delivers, fails or
// cancels it, as a quiet real socket does, so Foundation's own async receive() wrapper runs unchanged.
@interface PathwayFakeFrameSocket : NSURLSessionWebSocketTask
@property(nonatomic, copy) void (^onReceive)(void);
@property(nonatomic, copy) void (^pendingReceive)(NSURLSessionWebSocketMessage *, NSError *);
@property(nonatomic) NSInteger cancelCount;
/// Called on each cancel, after it is counted.
@property(nonatomic, copy) void (^onCancel)(void);
/// A cancel leaves the pending receive for the test to finish, like a message already in flight.
@property(nonatomic) BOOL holdsReceiveOnCancel;
/// The refused upgrade's HTTP status, or 0 once upgraded.
@property(nonatomic) NSInteger status;
@property(nonatomic) NSInteger fakeCloseCode;
@property NSInteger maximumMessageSize;
@property(nonatomic) NSInteger maximumMessageSizeAtResume;
@end

@implementation PathwayFakeFrameSocket
@synthesize maximumMessageSize = _fakeMaximumMessageSize;
- (void)resume { self.maximumMessageSizeAtResume = self.maximumMessageSize; }
- (NSURLResponse *)response {
    if (self.status == 0) return nil;
    return [[NSHTTPURLResponse alloc] initWithURL:[NSURL URLWithString:@"wss://unused.invalid"] statusCode:self.status HTTPVersion:nil headerFields:nil];
}
- (NSURLSessionWebSocketCloseCode)closeCode { return self.fakeCloseCode; }
- (void)complete:(NSURLSessionWebSocketMessage *)message error:(NSError *)error {
    void (^pending)(NSURLSessionWebSocketMessage *, NSError *) = self.pendingReceive;
    self.pendingReceive = nil;
    if (pending) pending(message, error);
}
/// Hands the pending receive one binary message.
- (void)deliver:(NSData *)data { [self complete:[[NSURLSessionWebSocketMessage alloc] initWithData:data] error:nil]; }
/// Ends the socket as the server did, with `status` and `fakeCloseCode` already set.
- (void)fail { [self complete:nil error:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorNetworkConnectionLost userInfo:nil]]; }
- (void)receiveMessageWithCompletionHandler:(void (^)(NSURLSessionWebSocketMessage *, NSError *))completion {
    self.pendingReceive = completion;
    void (^ready)(void) = self.onReceive;
    self.onReceive = nil;
    if (ready) ready();
}
- (void)cancelWithCloseCode:(NSURLSessionWebSocketCloseCode)code reason:(NSData *)reason {
    self.cancelCount += 1;
    if (!self.holdsReceiveOnCancel) {
        [self complete:nil error:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorCancelled userInfo:nil]];
    }
    void (^cancelled)(void) = self.onCancel;
    self.onCancel = nil;
    if (cancelled) cancelled();
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
